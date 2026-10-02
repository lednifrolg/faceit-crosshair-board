// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError, ErrorKind, interpret, parseRateLimit, parseRetryAfter, parseProfile,
  parseSearch, parseHistory, parseScoreboard, getScoreboard, resolveNickname, request,
} from "../src/lib/api.js";
import { fixture, json, fakeFetch } from "./helpers.js";

const headers = (h) => new Headers(h);
const JSON_CT = { "content-type": "application/json" };
const kindOf = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof ApiError); return e.kind; }
  assert.fail("expected an ApiError");
};

test("interpret: 200 JSON returns data and rate limit", () => {
  const { data, rateLimit } = interpret(200, headers({
    ...JSON_CT, "ratelimit-limit": "5, 5;w=30", "ratelimit-remaining": "4", "ratelimit-reset": "3",
  }), fixture("scoreboard.json"));
  assert.equal(data.payload.id, "1-d98dfbef-ffda-40d4-9bce-7d36de789c0b");
  assert.deepEqual(rateLimit, { limit: 5, remaining: 4, windowMs: 30000, resetMs: 3000, retryAfterMs: null });
});

test("interpret: Cloudflare challenge is detected before err_f0", () => {
  const html = fixture("challenge.html");
  assert.equal(kindOf(() => interpret(403, headers({ "content-type": "text/html; charset=UTF-8", "cf-mitigated": "challenge" }), html)), ErrorKind.CHALLENGE);
  // Without the header, a 403 HTML body is still a challenge.
  assert.equal(kindOf(() => interpret(403, headers({ "content-type": "text/html" }), html)), ErrorKind.CHALLENGE);
  // HTML on a 200 is an interstitial, not data.
  assert.equal(kindOf(() => interpret(200, headers({ "content-type": "text/html" }), html)), ErrorKind.CHALLENGE);
});

test("interpret: 403 JSON err_f0 is anonymous, 404 is not found", () => {
  assert.equal(kindOf(() => interpret(403, headers(JSON_CT), fixture("error-anonymous.json"))), ErrorKind.ANONYMOUS);
  assert.equal(kindOf(() => interpret(404, headers(JSON_CT), fixture("error-not-found.json"))), ErrorKind.NOT_FOUND);
  assert.equal(kindOf(() => interpret(500, headers(JSON_CT), "{}")), ErrorKind.HTTP);
  assert.equal(kindOf(() => interpret(200, headers(JSON_CT), "not json")), ErrorKind.BAD_BODY);
});

test("interpret: 429 carries retry-after", () => {
  try {
    interpret(429, headers({ ...JSON_CT, "ratelimit-retry-after": "12" }), "{}");
    assert.fail();
  } catch (e) {
    assert.equal(e.kind, ErrorKind.RATE_LIMITED);
    assert.equal(e.retryAfterMs, 12000);
  }
});

test("parseRateLimit: other bucket shapes and missing headers", () => {
  assert.equal(parseRateLimit(headers({ "ratelimit-limit": "10, 10;w=20" })).windowMs, 20000);
  // The "N, " prefix is optional in the draft: a bare policy must parse too.
  const bare = parseRateLimit(headers({ "ratelimit-limit": "10;w=20" }));
  assert.equal(bare.limit, 10);
  assert.equal(bare.windowMs, 20000);
  assert.deepEqual(parseRateLimit(headers({})), { limit: null, remaining: null, windowMs: null, resetMs: null, retryAfterMs: null });
});

test("parseRetryAfter: seconds and HTTP dates", () => {
  const now = Date.parse("2026-10-02T10:00:00Z");
  assert.equal(parseRetryAfter("7", now), 7000);
  assert.equal(parseRetryAfter("Fri, 02 Oct 2026 10:00:30 GMT", now), 30000);
  assert.equal(parseRetryAfter("garbage", now), null);
  assert.equal(parseRetryAfter(null, now), null);
});

test("parseProfile", () => {
  assert.deepEqual(parseProfile(json("nickname.json")), {
    id: "3b536dda-e3dd-40cd-baed-7e66ab050c8f",
    nickname: "ZywOo",
    avatar: "https://assets.faceit-cdn.net/avatars/3b536dda-e3dd-40cd-baed-7e66ab050c8f_1550499998143.png",
    country: "fr",
    level: 10,
    elo: 3392,
  });
  assert.throws(() => parseProfile({ payload: {} }), ApiError);
});

test("parseSearch", () => {
  const hits = parseSearch(json("search.json"));
  assert.equal(hits.length, 3);
  assert.deepEqual(Object.keys(hits[0]), ["id", "nickname", "avatar", "country"]);
  assert.equal(hits[2].avatar, null); // FACEIT sends "" for no avatar
});

test("parseHistory uses the room match id, not _id.matchId", () => {
  const h = parseHistory(json("history.json"));
  assert.equal(h.length, 10);
  assert.deepEqual(h[0], {
    matchId: "1-d98dfbef-ffda-40d4-9bce-7d36de789c0b",
    date: 1790542675000,
    map: "de_nuke",
    score: "13 / 7",
    elo: 3392,
    eloDelta: 21,
  });
});

test("parseScoreboard reads both id casings to the same result", () => {
  const snake = parseScoreboard(json("scoreboard.json"));
  const camel = parseScoreboard(json("scoreboard-camel.json"));
  assert.deepEqual(camel, snake);
  assert.equal(snake.hasStats, true);
  assert.equal(Object.keys(snake.crosshairs).length, 10);
  assert.equal(snake.crosshairs["3b536dda-e3dd-40cd-baed-7e66ab050c8f"], "CSGO-43Xd3-akOjE-fOHmW-GoRhM-sPcAB");
});

test("parseScoreboard: no teams means no stats", () => {
  assert.deepEqual(parseScoreboard({ payload: { cs2: { teams: [] } } }), { hasStats: false, crosshairs: {} });
  assert.throws(() => parseScoreboard({}), ApiError);
});

test("request sends credentials and bypasses the HTTP cache", async () => {
  const id = "1-d98dfbef-ffda-40d4-9bce-7d36de789c0b";
  const { impl, calls } = fakeFetch({
    [`/statistics/v1/cs2/matches/${id}/match-rounds/1/scoreboard-summary?statsType=2`]: { body: fixture("scoreboard.json") },
  });
  const { data } = await getScoreboard(id, { fetchImpl: impl });
  assert.equal(data.hasStats, true);
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.cache, "no-store");
});

test("request: a rejected fetch is a network error", async () => {
  const impl = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(getScoreboard("x", { fetchImpl: impl }), (e) => e.kind === ErrorKind.NETWORK);
});

test("resolveNickname: exact hit needs one request", async () => {
  const { impl, calls } = fakeFetch({ "/users/v1/nicknames/ZywOo": { body: fixture("nickname.json") } });
  const { data } = await resolveNickname(" ZywOo ", { fetchImpl: impl });
  assert.equal(data.nickname, "ZywOo");
  assert.equal(calls.length, 1);
});

test("resolveNickname: wrong case falls back to search, then the id", async () => {
  const { impl, calls } = fakeFetch({
    "/users/v1/nicknames/zywoo": { status: 404, body: fixture("error-not-found.json") },
    "/searcher/v1/players?query=zywoo&offset=0&limit=20": { body: fixture("search.json") },
    "/users/v1/users/3b536dda-e3dd-40cd-baed-7e66ab050c8f": { body: fixture("nickname.json") },
  });
  const { data } = await resolveNickname("zywoo", { fetchImpl: impl });
  assert.equal(data.nickname, "ZywOo");
  assert.equal(data.elo, 3392);
  assert.equal(calls.length, 3);
});

test("resolveNickname: search without an exact match is not found", async () => {
  const { impl } = fakeFetch({
    "/users/v1/nicknames/zyw": { status: 404, body: fixture("error-not-found.json") },
    "/searcher/v1/players?query=zyw&offset=0&limit=20": { body: fixture("search.json") },
  });
  await assert.rejects(resolveNickname("zyw", { fetchImpl: impl }), (e) => e.kind === ErrorKind.NOT_FOUND);
});

test("resolveNickname: a challenge is not swallowed by the search fallback", async () => {
  const { impl, calls } = fakeFetch({
    "/users/v1/nicknames/ZywOo": { status: 403, headers: { "content-type": "text/html", "cf-mitigated": "challenge" }, body: fixture("challenge.html") },
  });
  await assert.rejects(resolveNickname("ZywOo", { fetchImpl: impl }), (e) => e.kind === ErrorKind.CHALLENGE);
  assert.equal(calls.length, 1);
});

test("request: a stalled request times out as a network error", async () => {
  const { impl } = fakeFetch({ "/users/v1/users/x": { hang: true } });
  const t0 = Date.now();
  await assert.rejects(request("/users/v1/users/x", { fetchImpl: impl, timeoutMs: 50 }), (e) => e.kind === ErrorKind.NETWORK);
  assert.ok(Date.now() - t0 < 2000);
});

test("request: a caller's signal still aborts alongside the timeout", async () => {
  const { impl } = fakeFetch({ "/users/v1/users/x": { hang: true } });
  const ac = new AbortController();
  const p = request("/users/v1/users/x", { fetchImpl: impl, signal: ac.signal, timeoutMs: 60_000 });
  ac.abort();
  await assert.rejects(p, (e) => e.kind === ErrorKind.NETWORK);
});
