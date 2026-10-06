/* FACEIT Crosshair Board - FACEIT web API client
 *
 * Every endpoint here is one of faceit.com's own, unauthenticated web API routes; there is
 * no API key. All of them sit behind Cloudflare, which lets extension contexts through but
 * occasionally answers with a managed challenge instead (mostly on a cold profile). The
 * caller decides what to do about that; this module only turns every response into either
 * parsed data or an ApiError with a `kind` the queue can act on.
 *
 * Only the service worker calls this. Pure parsing lives in the exported parse* and
 * interpret functions so `node --test` can cover it without a browser.
 *
 * Copyright (C) 2026 Filip Tomasovych
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version. See the LICENSE file for details.
 */

export const BASE = "https://www.faceit.com/api";

/** What went wrong, from the queue's point of view. */
export const ErrorKind = Object.freeze({
  CHALLENGE: "challenge",       // Cloudflare managed challenge (403 + HTML). Transient.
  RATE_LIMITED: "rate_limited", // 429. Wait `retryAfterMs`, then retry.
  NOT_FOUND: "not_found",       // 404: unknown nickname, or a match with no advanced stats.
  ANONYMOUS: "anonymous",       // 403 JSON err_f0: needs a logged-in faceit.com session.
  HTTP: "http",                 // Any other non-2xx.
  NETWORK: "network",           // fetch() itself rejected (offline, DNS, aborted).
  BAD_BODY: "bad_body",         // 2xx whose body is not the JSON we expect.
});

export class ApiError extends Error {
  constructor(kind, { status = null, code = null, retryAfterMs = null, rateLimit = null, cause } = {}) {
    super(`${kind}${status ? ` ${status}` : ""}${code ? ` ${code}` : ""}`, { cause });
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.rateLimit = rateLimit; // set when FACEIT answered, so failures can pace the queue too
  }
}

const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const secondsToMs = (s) => (s == null ? null : Math.round(s * 1000));

// ------------------------------------------------------------- rate limits

/* FACEIT sends IETF draft headers: `ratelimit-limit: 5, 5;w=30`, `ratelimit-remaining: 4`,
 * `ratelimit-reset: 3` (seconds). The bucket differs per request (5/30 s and 10/20 s are
 * both common on the scoreboard), so the queue paces from these rather than a constant.
 * The leading "N, " is optional in the draft, so `10;w=20` alone must parse too. */
export function parseRateLimit(headers, now = Date.now()) {
  const limitHeader = headers.get("ratelimit-limit") ?? "";
  const limit = /^\s*(\d+)/.exec(limitHeader);
  const window = /;\s*w=(\d+)/.exec(limitHeader);
  return {
    limit: limit ? Number(limit[1]) : null,
    remaining: num(headers.get("ratelimit-remaining")),
    windowMs: window ? Number(window[1]) * 1000 : null,
    resetMs: secondsToMs(num(headers.get("ratelimit-reset"))),
    retryAfterMs: parseRetryAfter(
      headers.get("ratelimit-retry-after") ?? headers.get("retry-after"),
      now
    ),
  };
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return null;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return secondsToMs(Number(value));
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

// ------------------------------------------------------- response handling

const isHtml = (contentType, text) =>
  /text\/html/i.test(contentType ?? "") || /^\s*</.test(text);

/**
 * Turns a finished response into `{ data, rateLimit }` or throws an ApiError.
 * Takes plain values rather than a Response so tests can feed it fixtures.
 */
export function interpret(status, headers, text, now = Date.now()) {
  const rateLimit = parseRateLimit(headers, now);
  const contentType = headers.get("content-type");
  const fail = (kind, extra) => new ApiError(kind, { status, rateLimit, ...extra });

  // Checked first: a challenge is a 403 too, and must not be mistaken for err_f0.
  if (headers.get("cf-mitigated") === "challenge" || (status === 403 && isHtml(contentType, text))) {
    throw fail(ErrorKind.CHALLENGE);
  }
  if (status === 429) throw fail(ErrorKind.RATE_LIMITED, { retryAfterMs: rateLimit.retryAfterMs });

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // An HTML body on a 2xx is Cloudflare too (an interstitial served with 200).
    if (status >= 200 && status < 300) {
      throw fail(isHtml(contentType, text) ? ErrorKind.CHALLENGE : ErrorKind.BAD_BODY);
    }
  }

  if (status >= 200 && status < 300) {
    if (json == null) throw fail(ErrorKind.BAD_BODY);
    return { data: json, rateLimit };
  }

  const code = json?.errors?.[0]?.code ?? null;
  if (status === 404) throw fail(ErrorKind.NOT_FOUND, { code });
  if (status === 403 && code === "err_f0") throw fail(ErrorKind.ANONYMOUS, { code });
  throw fail(ErrorKind.HTTP, { code });
}

/* `include` because a logged-in user's faceit.com session unlocks err_f0 matches, and the
 * Cloudflare `__cf_bm` cookie it carries is SameSite=None, so it works from an extension.
 * `no-store` because history is `max-age=30` and a cached 200 carries no rate-limit
 * headers, which would blind the pacing. */
export const REQUEST_TIMEOUT_MS = 20_000;

/* The timeout turns a stalled connection into a NETWORK error the queue backs off from;
 * without it one hung request would hold the single-flight queue until Chrome killed
 * the worker. */
export async function request(path, { fetchImpl = globalThis.fetch, signal, now = Date.now, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(BASE + path, {
      credentials: "include",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (cause) {
    throw new ApiError(ErrorKind.NETWORK, { cause });
  }
  let text;
  try {
    text = await res.text();
  } catch (cause) {
    throw new ApiError(ErrorKind.NETWORK, { status: res.status, cause });
  }
  return interpret(res.status, res.headers, text, now());
}

// ----------------------------------------------------------------- parsing

/** The API returns camelCase on some matches and snake_case on others. */
const pick = (obj, ...keys) => {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return undefined;
};

/** `/users/v1/nicknames/{nick}` and `/users/v1/users/{id}` share this payload. */
export function parseProfile(json) {
  const p = json?.payload;
  if (!p?.id || !p?.nickname) throw new ApiError(ErrorKind.BAD_BODY);
  const cs2 = p.games?.cs2 ?? {};
  return {
    id: p.id,
    nickname: p.nickname,
    avatar: p.avatar || null,
    country: p.country || null,
    level: num(cs2.skill_level),
    elo: num(cs2.faceit_elo),
  };
}

/** Search results. Their `skill_level` is always 0, so it is deliberately not read. */
export function parseSearch(json) {
  if (!Array.isArray(json?.payload)) throw new ApiError(ErrorKind.BAD_BODY);
  return json.payload
    .filter((p) => p?.id && p?.nickname)
    .map((p) => ({ id: p.id, nickname: p.nickname, avatar: p.avatar || null, country: p.country || null }));
}

/* A bare array, newest first. Items carry two match ids: `_id.matchId` is an internal hex
 * id, the top-level `matchId` (`1-<uuid>`) is the one the room URL and the scoreboard use.
 * The player's own stats come along under FACEIT's coded keys. They have no FACEIT
 * Rating (the scoreboard does), but they are there for matches without a scoreboard. */
export function parseHistory(json) {
  if (!Array.isArray(json)) throw new ApiError(ErrorKind.BAD_BODY);
  return json
    .filter((m) => typeof m?.matchId === "string")
    .map((m) => ({
      matchId: m.matchId,
      date: num(m.date),
      map: m.i1 || null,
      score: m.i18 || null,
      elo: num(m.elo),
      eloDelta: num(pick(m, "elo_delta", "eloDelta")),
      stats: parseMatchStats(m),
    }));
}

/* One player's stats in one match, the same shape from either source; null when FACEIT
 * left them out. `hs` is a percent of kills, `rating` the FACEIT Rating. */
const matchStats = (stats) => (stats.kills == null || stats.deaths == null ? null : stats);

export const parseMatchStats = (m) =>
  matchStats({
    kills: num(m.i6),
    assists: num(m.i7),
    deaths: num(m.i8),
    rounds: num(m.i12),
    kd: num(m.c2),
    adr: num(m.c10),
    hs: num(m.c4),
    rating: null,
  });

/** A scoreboard player's `stats`. Values come unrounded; the board rounds for display. */
export function parseScoreboardStats(s) {
  const hsRate = num(pick(s, "hsRate", "hs_rate"));
  return matchStats({
    kills: num(s?.kills),
    assists: num(s?.assists),
    deaths: num(s?.deaths),
    rounds: num(pick(s, "roundsPlayed", "rounds_played")),
    kd: num(s?.kd),
    adr: num(s?.adr),
    hs: hsRate == null ? null : hsRate * 100,
    rating: num(pick(s, "faceitRating", "faceit_rating")),
  });
}

/* Crosshairs and stats of everyone in the match, keyed by player id, so one request serves
 * every tracked player who was in it. A match without advanced stats comes back as a 404
 * (see interpret) or, occasionally, as a 200 with no teams; `hasStats` covers the latter. */
export function parseScoreboard(json) {
  const teams = json?.payload?.cs2?.teams;
  if (json?.payload == null) throw new ApiError(ErrorKind.BAD_BODY);
  const crosshairs = {};
  const stats = {};
  for (const team of Array.isArray(teams) ? teams : []) {
    for (const pl of team?.players ?? []) {
      const id = pick(pl, "playerId", "player_id");
      if (!id) continue;
      crosshairs[id] = pl.crosshair || null;
      stats[id] = parseScoreboardStats(pl.stats);
    }
  }
  return { hasStats: Object.keys(crosshairs).length > 0, crosshairs, stats };
}

// --------------------------------------------------------------- endpoints

const enc = encodeURIComponent;
const parsed = (parse) => async (promise) => {
  const { data, rateLimit } = await promise;
  try {
    return { data: parse(data), rateLimit };
  } catch (err) {
    if (err instanceof ApiError) err.rateLimit ??= rateLimit;
    throw err;
  }
};

/** Exact, case-sensitive nickname lookup. Unknown nickname -> NOT_FOUND. */
export const getPlayerByNickname = (nickname, opts) =>
  parsed(parseProfile)(request(`/users/v1/nicknames/${enc(nickname)}`, opts));

export const getPlayer = (id, opts) =>
  parsed(parseProfile)(request(`/users/v1/users/${enc(id)}`, opts));

/* Case-insensitive prefix search; FACEIT wants at least 2 characters. Twenty results,
 * because the exact match of a common nickname can rank below other prefix matches. */
export const SEARCH_LIMIT = 20;
export const searchPlayers = (query, { limit = SEARCH_LIMIT, ...opts } = {}) =>
  parsed(parseSearch)(request(`/searcher/v1/players?query=${enc(query)}&offset=0&limit=${limit}`, opts));

export const getHistory = (playerId, { size = 10, ...opts } = {}) =>
  parsed(parseHistory)(request(`/stats/v1/stats/time/users/${enc(playerId)}/games/cs2?page=0&size=${size}`, opts));

export const getScoreboard = (matchId, opts) =>
  parsed(parseScoreboard)(
    request(`/statistics/v1/cs2/matches/${enc(matchId)}/match-rounds/1/scoreboard-summary?statsType=2`, opts)
  );

/**
 * Nickname as a user types it -> profile. The nickname route is case sensitive, so on a
 * miss fall back to search and take its case-insensitive exact match, then look that up
 * for elo and level (search results carry neither reliably).
 */
export async function resolveNickname(input, opts) {
  const nickname = input.trim();
  if (!nickname) throw new ApiError(ErrorKind.NOT_FOUND);
  try {
    return await getPlayerByNickname(nickname, opts);
  } catch (err) {
    if (err?.kind !== ErrorKind.NOT_FOUND || nickname.length < 2) throw err;
  }
  const { data: hits } = await searchPlayers(nickname, opts);
  const hit = hits.find((p) => p.nickname.toLowerCase() === nickname.toLowerCase());
  if (!hit) throw new ApiError(ErrorKind.NOT_FOUND);
  return getPlayer(hit.id, opts);
}
