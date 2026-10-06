/* FACEIT Crosshair Board - data model and cache
 *
 * storage.sync (small, follows the user across browsers):
 *   players: [{ id, nickname }]            display order = order added
 *
 * storage.local (cache, rebuildable from the network):
 *   profiles: { [playerId]: { nickname, avatar, level, elo, fetchedAt } }
 *   history:  { [playerId]: { items: [{ matchId, date, map, score, stats }], fetchedAt, failedAt } }
 *   matches:  { [matchId]: { status, crosshairs, stats, attempts, lastAttemptAt } }
 *
 * Map, date and score live in the player's history, not in `matches`: the score is
 * "13 / 7" from that player's side, so two tracked players on opposite teams of one match
 * need different values. `matches` only holds what the scoreboard request produced, with
 * the crosshair and stats (FACEIT Rating included) of all ten players, so adding a
 * teammate later costs no request for the matches already cached. History items carry
 * the player's stats too, without a rating, for matches that have no scoreboard. A match id with no `matches` entry has never been attempted.
 *
 * The service worker is the only writer of storage.local. storage.sync `players` may also
 * be written by other contexts, so the worker treats changes to it as the source of truth
 * rather than assuming it made them.
 *
 * Copyright (C) 2026 Filip Tomasovych
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version. See the LICENSE file for details.
 */

export const MATCHES_PER_PLAYER = 10;

/* storage.sync allows 8 KB per item and `players` is one item. An entry is about 90 bytes
 * of JSON, so this leaves ample headroom; past it a sync write would fail outright. */
export const MAX_PLAYERS = 50;

export const SyncKey = Object.freeze({ PLAYERS: "players" });
export const LocalKey = Object.freeze({
  PROFILES: "profiles",
  HISTORY: "history",
  MATCHES: "matches",
});

export const MatchStatus = Object.freeze({
  OK: "ok",               // final: crosshairs and stats stored
  NONE: "none",           // no advanced stats (yet); see NONE_RETRY_*
  ANONYMOUS: "anonymous", // err_f0: only a logged-in faceit.com session sees it; see ANONYMOUS_*
  ERROR: "error",         // FACEIT kept failing on this match (5xx, odd body); see ERROR_*
});

const H = 60 * 60 * 1000;

/* FACEIT parses demos some minutes after a match, so a fresh match without stats is
 * worth a few more tries. Three tries, at least two hours apart, and only while the match
 * is under six hours old; a match first seen when already older gets one try. */
export const NONE_RETRY_LIMIT = 3;
export const NONE_RETRY_SPACING_MS = 2 * H;
export const NONE_RETRY_WINDOW_MS = 6 * H;

/* Logging in on faceit.com unlocks err_f0 matches, and nothing tells the extension when
 * that happens, so look again now and then while the match is on the board. A click on
 * the cell retries at once (see worker.js retryMatch). */
export const ANONYMOUS_RETRY_SPACING_MS = 6 * H;

/* An error record stands for one dropped job, which already made JOB_MAX_FAILURES
 * requests. A few more rounds, then it's final, so a broken match can't keep costing
 * requests on every refresh. */
export const ERROR_RETRY_LIMIT = 3;
export const ERROR_RETRY_SPACING_MS = 1 * H;

// ------------------------------------------------------------ fetch policy

/** Whether a no-stats match still has tries left (now or later). */
function noneRetriesLeft(match, item, now) {
  return match.attempts < NONE_RETRY_LIMIT && item?.date != null && now - item.date <= NONE_RETRY_WINDOW_MS;
}

/** Whether `match` (possibly undefined) should be fetched now, given its history item. */
export function needsFetch(match, item, now) {
  if (!match) return true;
  const since = now - (match.lastAttemptAt ?? 0);
  switch (match.status) {
    case MatchStatus.NONE:
      return noneRetriesLeft(match, item, now) && since >= NONE_RETRY_SPACING_MS;
    case MatchStatus.ANONYMOUS:
      return since >= ANONYMOUS_RETRY_SPACING_MS;
    case MatchStatus.ERROR:
      return match.attempts < ERROR_RETRY_LIMIT && since >= ERROR_RETRY_SPACING_MS;
    default:
      // ok is final, except a record from before stats were kept: one more request fills them.
      return match.stats === undefined;
  }
}

/** Match ids in `items` that need a scoreboard request, newest first. */
export function matchesToFetch(items, matches, now) {
  return items.filter((it) => needsFetch(matches?.[it.matchId], it, now)).map((it) => it.matchId);
}

// --------------------------------------------------------------- records

/** History items as stored: newest first, capped, only the fields the board shows. FACEIT
 * now and then lists one match twice; only its first (newest) listing is kept, so the
 * row still holds ten distinct matches. */
export function historyEntry(items, now) {
  const seen = new Set();
  const distinct = items.filter((it) => !seen.has(it.matchId) && seen.add(it.matchId));
  return {
    items: distinct.slice(0, MATCHES_PER_PLAYER).map(({ matchId, date, map, score, stats }) => ({
      matchId,
      date: date ?? null,
      map: map ?? null,
      score: score ?? null,
      stats: stats ?? null,
    })),
    fetchedAt: now,
    failedAt: null,
  };
}

export function profileEntry(profile, now) {
  const { nickname, avatar = null, level = null, elo = null } = profile;
  return { nickname, avatar, level, elo, fetchedAt: now };
}

const record = (status, crosshairs, stats) => (prev, now) => ({
  status,
  crosshairs,
  stats,
  attempts: (prev?.status === status ? prev.attempts ?? 0 : 0) + 1,
  lastAttemptAt: now,
});

/* A refetch of an ok record (see needsFetch) that fails keeps the crosshairs it had, and
 * empty stats so it isn't fetched again. */
const failedRecord = (status) => (prev, now) =>
  prev?.status === MatchStatus.OK ? { ...prev, stats: prev.stats ?? {}, lastAttemptAt: now } : record(status, {}, {})(prev, now);

/** The match record after a scoreboard request (`parseScoreboard` output) came back. */
export function scoreboardRecord(prev, scoreboard, now) {
  return scoreboard.hasStats ? record(MatchStatus.OK, scoreboard.crosshairs, scoreboard.stats ?? {})(prev, now) : noStatsRecord(prev, now);
}

/** After a 404 or an empty scoreboard. */
export const noStatsRecord = failedRecord(MatchStatus.NONE);
/** After an err_f0. */
export const anonymousRecord = failedRecord(MatchStatus.ANONYMOUS);
/** After the queue gave up on the match's job. */
export const errorRecord = failedRecord(MatchStatus.ERROR);

/** `matches` without entries no tracked player's history refers to any more. */
export function collectGarbage(matches, history) {
  const live = new Set();
  for (const h of Object.values(history ?? {})) for (const it of h?.items ?? []) live.add(it.matchId);
  return Object.fromEntries(Object.entries(matches ?? {}).filter(([id]) => live.has(id)));
}

// --------------------------------------------------------------- board view

export const CellState = Object.freeze({
  LOADING: "loading",     // not fetched yet, or a retry is due
  CODE: "code",           // has a share code
  NO_CODE: "no_code",     // match has stats, but this player's crosshair is missing
  PENDING: "pending",     // no stats yet, will be tried again later
  NO_STATS: "no_stats",   // final: no advanced stats
  ANONYMOUS: "anonymous", // needs a logged-in session; retried now and then, or on click
  ERROR: "error",         // FACEIT kept failing; `final` says whether it will be retried
  EMPTY: "empty",         // the player has fewer than 10 matches
});

/**
 * The ten cells of one board row, newest first.
 *
 * `changed` compares a cell's crosshair with the nearest older cell that has one:
 * true -> orange marker, false -> dimmed, null -> nothing older to compare with (or this
 * cell has no code). `keyOf(code)` maps a share code to what identifies the crosshair; the
 * page passes one that decodes, because the same crosshair has different codes across
 * share code formats. Without it, codes are compared as strings.
 *
 * `stats` are the player's in that match: the scoreboard's, which carry the FACEIT Rating,
 * else the history's (no rating), which also cover matches without a scoreboard.
 * Cells with a code also get `withCrosshair` and `withOthers` (see combineStats): the
 * player's stats over the row's matches with this crosshair, and with any other one.
 */
export function rowCells(playerId, historyEntry, matches, now, keyOf = (code) => code) {
  if (!historyEntry?.fetchedAt) {
    // Never loaded: still coming, or failing. Either way not "no matches".
    const state = historyEntry?.failedAt ? CellState.ERROR : CellState.LOADING;
    return Array.from({ length: MATCHES_PER_PLAYER }, () => ({ state, matchId: null, code: null, changed: null, final: false, history: true }));
  }
  const items = historyEntry.items ?? [];
  const cells = [];
  for (let i = 0; i < MATCHES_PER_PLAYER; i++) {
    const item = items[i];
    if (!item) {
      cells.push({ state: CellState.EMPTY, matchId: null, code: null, changed: null });
      continue;
    }
    const match = matches?.[item.matchId];
    let state;
    let code = null;
    let final = false;
    let stats = null;
    if (!match) {
      state = CellState.LOADING;
    } else if (match.status === MatchStatus.OK) {
      code = match.crosshairs?.[playerId] ?? null;
      stats = match.stats?.[playerId] ?? null;
      state = code ? CellState.CODE : CellState.NO_CODE;
    } else if (match.status === MatchStatus.NONE) {
      if (needsFetch(match, item, now)) state = CellState.LOADING;
      else state = noneRetriesLeft(match, item, now) ? CellState.PENDING : CellState.NO_STATS;
    } else if (match.status === MatchStatus.ANONYMOUS) {
      state = CellState.ANONYMOUS;
    } else {
      state = CellState.ERROR;
      final = !needsFetch(match, item, now) && match.attempts >= ERROR_RETRY_LIMIT;
    }
    cells.push({ state, matchId: item.matchId, date: item.date, map: item.map, score: item.score, stats: stats ?? item.stats ?? null, code, changed: null, final });
  }
  let older = null; // walk oldest -> newest so each cell sees the nearest older crosshair
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    if (!c.code) continue;
    const key = keyOf(c.code);
    if (older != null) c.changed = key !== older;
    older = key;
  }
  // How the player did with each cell's crosshair, against the other crosshairs in the row.
  const known = cells.filter((c) => c.code && c.stats);
  for (const c of cells) {
    if (!c.code) continue;
    const key = keyOf(c.code);
    c.withCrosshair = combineStats(known.filter((o) => keyOf(o.code) === key).map((o) => o.stats));
    c.withOthers = combineStats(known.filter((o) => keyOf(o.code) !== key).map((o) => o.stats));
  }
  return cells;
}

/**
 * Several matches' stats as one: `{ matches, rating, kd, adr }`, or null for none. K/D is
 * total kills over total deaths; rating and ADR are weighted by rounds, as one long match
 * would count them, so a short stomp doesn't weigh as much as a full 13-11. Matches that
 * lack a value (no rating in history stats) are left out of that value only.
 */
export function combineStats(list) {
  if (!list.length) return null;
  const sum = (f) => list.reduce((n, s) => n + (f(s) ?? 0), 0);
  const perRound = (field) => {
    const has = (s) => s[field] != null && s.rounds != null;
    const rounds = sum((s) => (has(s) ? s.rounds : 0));
    return rounds ? sum((s) => (has(s) ? s[field] * s.rounds : 0)) / rounds : null;
  };
  const deaths = sum((s) => s.deaths);
  return {
    matches: list.length,
    rating: perRound("rating"),
    kd: deaths ? sum((s) => s.kills) / deaths : null,
    adr: perRound("adr"),
  };
}

// ---------------------------------------------------------------- storage

/**
 * Serialises read-modify-write on chrome.storage, which has no transactions: two
 * overlapping updates in the worker would otherwise drop one another's changes.
 * `areas` is `{ sync, local }` of StorageArea-likes (`get`, `set`), so tests can pass maps.
 */
export function createStore(areas) {
  let tail = Promise.resolve();
  const serial = (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };

  const read = async (area, key, fallback) => (await areas[area].get(key))[key] ?? fallback;

  return {
    /** Unserialised read; safe inside an update's `fn`, which can't deadlock on it. */
    read,
    /** Runs `fn(current)` and stores what it returns, one update at a time. */
    update: (area, key, fallback, fn) =>
      serial(async () => {
        const next = await fn(await read(area, key, fallback));
        await areas[area].set({ [key]: next });
        return next;
      }),
    /** Several keys of one area in one step; `fn` gets and returns `{ key: value }`. */
    updateMany: (area, defaults, fn) =>
      serial(async () => {
        const got = await areas[area].get(Object.keys(defaults));
        const current = Object.fromEntries(Object.entries(defaults).map(([k, d]) => [k, got[k] ?? d]));
        const next = await fn(current);
        await areas[area].set(next);
        return next;
      }),
  };
}

const LOCAL_DEFAULTS = { [LocalKey.PROFILES]: {}, [LocalKey.HISTORY]: {}, [LocalKey.MATCHES]: {} };

const onBoard = async (store, playerId) =>
  (await store.read("sync", SyncKey.PLAYERS, [])).some((p) => p.id === playerId);

export const AddResult = Object.freeze({ ADDED: "added", EXISTS: "exists", FULL: "full" });

/** Appends a resolved profile to the board. */
export async function addPlayer(store, profile, now) {
  let result = AddResult.ADDED;
  await store.update("sync", SyncKey.PLAYERS, [], (players) => {
    if (players.some((p) => p.id === profile.id)) result = AddResult.EXISTS;
    else if (players.length >= MAX_PLAYERS) result = AddResult.FULL;
    else return [...players, { id: profile.id, nickname: profile.nickname }];
    return players;
  });
  if (result !== AddResult.FULL) {
    await store.update("local", LocalKey.PROFILES, {}, (profiles) => ({ ...profiles, [profile.id]: profileEntry(profile, now) }));
  }
  return result;
}

/** Takes a player off the board. Their cache goes in pruneLocal, which the worker runs
 * on every shrinking `players` change, whoever wrote it. */
export function removePlayer(store, playerId) {
  return store.update("sync", SyncKey.PLAYERS, [], (players) => players.filter((p) => p.id !== playerId));
}

/**
 * Drops cached profiles and history of players no longer on the board, then the matches
 * nobody refers to. `players` is read inside the serialised step, so a player re-added in
 * the meantime is kept.
 */
export function pruneLocal(store) {
  return store.updateMany("local", LOCAL_DEFAULTS, async ({ profiles, history, matches }) => {
    const keep = new Set((await store.read("sync", SyncKey.PLAYERS, [])).map((p) => p.id));
    const only = (obj) => Object.fromEntries(Object.entries(obj).filter(([id]) => keep.has(id)));
    const h = only(history);
    return { profiles: only(profiles), history: h, matches: collectGarbage(matches, h) };
  });
}

/**
 * Stores a fresh history and returns the match ids that now need a scoreboard request, or
 * null when the player left the board while the request was in flight (then nothing is
 * stored, so no orphan history keeps their matches alive or queued).
 */
export async function saveHistory(store, playerId, items, now) {
  let toFetch = null;
  await store.updateMany("local", LOCAL_DEFAULTS, async (local) => {
    if (!(await onBoard(store, playerId))) return local;
    const { profiles, history, matches } = local;
    const entry = historyEntry(items, now);
    const h = { ...history, [playerId]: entry };
    // The newest item's elo is the player's current elo, one request cheaper than a profile.
    const elo = items[0]?.elo;
    const p = profiles[playerId] && elo != null ? { ...profiles, [playerId]: { ...profiles[playerId], elo } } : profiles;
    const m = collectGarbage(matches, h);
    toFetch = matchesToFetch(entry.items, m, now);
    return { profiles: p, history: h, matches: m };
  });
  return toFetch;
}

/** The queue gave up on a player's history: remember when, keeping what was there. */
export function saveHistoryFailure(store, playerId, now) {
  return store.update("local", LocalKey.HISTORY, {}, async (history) => {
    if (!(await onBoard(store, playerId))) return history;
    const prev = history[playerId] ?? { items: [], fetchedAt: null };
    return { ...history, [playerId]: { ...prev, failedAt: now } };
  });
}

/** Stores the outcome of one scoreboard request; `makeRecord(prev, now)` builds it. */
export function saveMatch(store, matchId, makeRecord, now) {
  return store.update("local", LocalKey.MATCHES, {}, (matches) => ({ ...matches, [matchId]: makeRecord(matches[matchId], now) }));
}
