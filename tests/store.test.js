// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MatchStatus, CellState, AddResult, MAX_PLAYERS, NONE_RETRY_SPACING_MS, NONE_RETRY_WINDOW_MS,
  ANONYMOUS_RETRY_SPACING_MS, ERROR_RETRY_LIMIT, ERROR_RETRY_SPACING_MS,
  needsFetch, matchesToFetch, historyEntry, scoreboardRecord, noStatsRecord, anonymousRecord, errorRecord,
  collectGarbage, rowCells, addPlayer, removePlayer, pruneLocal,
  saveHistory, saveHistoryFailure, saveMatch,
} from "../src/lib/store.js";
import { parseHistory, parseScoreboard } from "../src/lib/api.js";
import { json, memoryStore } from "./helpers.js";

const H = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const ZYWOO = "3b536dda-e3dd-40cd-baed-7e66ab050c8f";

test("needsFetch: unseen, final and retryable matches", () => {
  const fresh = { date: NOW - 1 * H };
  assert.equal(needsFetch(undefined, fresh, NOW), true);
  assert.equal(needsFetch({ status: MatchStatus.OK, attempts: 1 }, fresh, NOW), false);

  const none = (attempts, lastAttemptAt) => ({ status: MatchStatus.NONE, attempts, lastAttemptAt });
  assert.equal(needsFetch(none(1, NOW - NONE_RETRY_SPACING_MS), fresh, NOW), true);
  assert.equal(needsFetch(none(1, NOW - NONE_RETRY_SPACING_MS + 1), fresh, NOW), false, "too soon");
  assert.equal(needsFetch(none(3, 0), fresh, NOW), false, "out of tries");
  assert.equal(needsFetch(none(1, 0), { date: NOW - NONE_RETRY_WINDOW_MS - 1 }, NOW), false, "too old");
  assert.equal(needsFetch(none(1, 0), { date: null }, NOW), false, "unknown date is final");
});

test("a no-stats match is tried at most three times", () => {
  const item = { matchId: "m", date: NOW };
  let rec;
  let t = NOW;
  let tries = 0;
  while (needsFetch(rec, item, t)) {
    rec = noStatsRecord(rec, t);
    tries++;
    t += NONE_RETRY_SPACING_MS;
  }
  assert.equal(tries, 3);
});

test("matchesToFetch keeps history order", () => {
  const items = [{ matchId: "a", date: NOW }, { matchId: "b", date: NOW }, { matchId: "c", date: NOW }];
  assert.deepEqual(matchesToFetch(items, { b: { status: MatchStatus.OK } }, NOW), ["a", "c"]);
});

test("historyEntry caps at 10 and keeps only board fields", () => {
  const entry = historyEntry([...parseHistory(json("history.json")), { matchId: "extra" }], NOW);
  assert.equal(entry.items.length, 10);
  assert.deepEqual(entry.items[0], { matchId: "1-d98dfbef-ffda-40d4-9bce-7d36de789c0b", date: 1790542675000, map: "de_nuke", score: "13 / 7" });
  assert.equal(entry.fetchedAt, NOW);
});

test("records count attempts", () => {
  const sb = parseScoreboard(json("scoreboard.json"));
  const ok = scoreboardRecord(noStatsRecord(undefined, NOW), sb, NOW + 1);
  assert.equal(ok.status, MatchStatus.OK);
  assert.equal(ok.attempts, 1, "counted per status");
  assert.equal(Object.keys(ok.crosshairs).length, 10);
  assert.equal(scoreboardRecord(undefined, { hasStats: false, crosshairs: {}, scores: [] }, NOW).status, MatchStatus.NONE);
  assert.equal(anonymousRecord(undefined, NOW).status, MatchStatus.ANONYMOUS);
});

test("collectGarbage drops matches no history refers to", () => {
  const matches = { a: {}, b: {}, c: {} };
  const history = { p1: { items: [{ matchId: "a" }] }, p2: { items: [{ matchId: "c" }] } };
  assert.deepEqual(Object.keys(collectGarbage(matches, history)), ["a", "c"]);
});

test("needsFetch: anonymous matches are looked at again now and then", () => {
  const anon = (lastAttemptAt) => ({ status: MatchStatus.ANONYMOUS, attempts: 1, lastAttemptAt });
  assert.equal(needsFetch(anon(NOW - ANONYMOUS_RETRY_SPACING_MS + 1), {}, NOW), false);
  assert.equal(needsFetch(anon(NOW - ANONYMOUS_RETRY_SPACING_MS), {}, NOW), true);
});

test("needsFetch: an error record gets a few spaced retries, then is final", () => {
  const err = (attempts, lastAttemptAt) => ({ status: MatchStatus.ERROR, attempts, lastAttemptAt });
  assert.equal(needsFetch(err(1, NOW - ERROR_RETRY_SPACING_MS), {}, NOW), true);
  assert.equal(needsFetch(err(1, NOW - ERROR_RETRY_SPACING_MS + 1), {}, NOW), false);
  assert.equal(needsFetch(err(ERROR_RETRY_LIMIT, 0), {}, NOW), false);
});

test("records count attempts per status", () => {
  const e = errorRecord(errorRecord(undefined, NOW), NOW);
  assert.equal(e.attempts, 2);
  assert.equal(noStatsRecord(e, NOW).attempts, 1, "a new status starts its own count");
});

test("rowCells: states, padding and change markers", () => {
  const item = (matchId) => ({ matchId, date: NOW - 10 * H, map: "de_nuke", score: "13 / 7" });
  const ok = (code) => ({ status: MatchStatus.OK, crosshairs: { me: code }, attempts: 1 });
  const history = { items: ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map(item), fetchedAt: NOW };
  const matches = {
    m1: ok("B"),                                        // newest: changed from A
    m2: ok("A"),                                        // same as m4 (m3 has no code)
    m3: { status: MatchStatus.NONE, attempts: 1, lastAttemptAt: NOW }, // final: 10 h old
    m4: ok("A"),                                        // same as m5
    m5: ok("A"),                                        // oldest with a code
    m6: { status: MatchStatus.OK, crosshairs: { other: "X" }, attempts: 1 },
    // m7 missing: never fetched
  };
  const cells = rowCells("me", history, matches, NOW);
  assert.equal(cells.length, 10);
  assert.deepEqual(cells.map((c) => c.state), [
    CellState.CODE, CellState.CODE, CellState.NO_STATS, CellState.CODE, CellState.CODE,
    CellState.NO_CODE, CellState.LOADING, CellState.EMPTY, CellState.EMPTY, CellState.EMPTY,
  ]);
  assert.deepEqual(cells.slice(0, 5).map((c) => c.changed), [true, false, null, false, null]);
  assert.equal(cells[0].map, "de_nuke");
});

test("rowCells: a no-stats match shows loading when a retry is due, pending in between", () => {
  const history = { items: [{ matchId: "m", date: NOW - 1 * H }], fetchedAt: NOW };
  const due = { m: { status: MatchStatus.NONE, attempts: 1, lastAttemptAt: NOW - NONE_RETRY_SPACING_MS } };
  assert.equal(rowCells("me", history, due, NOW)[0].state, CellState.LOADING);
  const between = { m: { status: MatchStatus.NONE, attempts: 1, lastAttemptAt: NOW - 1 } };
  assert.equal(rowCells("me", history, between, NOW)[0].state, CellState.PENDING);
  const spent = { m: { status: MatchStatus.NONE, attempts: 3, lastAttemptAt: NOW - 1 } };
  assert.equal(rowCells("me", history, spent, NOW)[0].state, CellState.NO_STATS);
});

test("rowCells: a history that never loaded is loading or an error, not ten empty cells", () => {
  assert.ok(rowCells("me", undefined, {}, NOW).every((c) => c.state === CellState.LOADING && c.history));
  const failed = { items: [], fetchedAt: null, failedAt: NOW };
  assert.ok(rowCells("me", failed, {}, NOW).every((c) => c.state === CellState.ERROR));
  // A refresh that failed after an earlier success keeps showing the earlier matches.
  const stale = { items: [{ matchId: "m", date: NOW }], fetchedAt: NOW - H, failedAt: NOW };
  assert.equal(rowCells("me", stale, {}, NOW)[0].state, CellState.LOADING);
});

test("rowCells: error cells say whether they are final", () => {
  const history = { items: [{ matchId: "a", date: NOW }, { matchId: "b", date: NOW }], fetchedAt: NOW };
  const matches = {
    a: { status: MatchStatus.ERROR, attempts: 1, lastAttemptAt: NOW },
    b: { status: MatchStatus.ERROR, attempts: ERROR_RETRY_LIMIT, lastAttemptAt: NOW },
  };
  const [a, b] = rowCells("me", history, matches, NOW);
  assert.deepEqual([a.state, a.final, b.state, b.final], [CellState.ERROR, false, CellState.ERROR, true]);
});

test("rowCells: keyOf decides what counts as a change", () => {
  const ok = (code) => ({ status: MatchStatus.OK, crosshairs: { me: code }, attempts: 1 });
  const history = { items: [{ matchId: "new" }, { matchId: "old" }], fetchedAt: NOW };
  const matches = { new: ok("CS-same-crosshair"), old: ok("CSGO-same-crosshair") };
  assert.equal(rowCells("me", history, matches, NOW)[0].changed, true, "strings differ");
  const keyOf = (code) => code.replace(/^CS(GO)?-/, "");
  assert.equal(rowCells("me", history, matches, NOW, keyOf)[0].changed, false, "same crosshair");
});

test("createStore serialises overlapping updates", async () => {
  const { areas, store } = memoryStore({}, {});
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    store.update("local", "n", 0, async (n) => { await new Promise((r) => setTimeout(r, Math.random() * 3)); return n + 1; })
  ));
  assert.equal(areas.local.data.n, 20);
});

test("createStore keeps going after a failed update", async () => {
  const { store } = memoryStore({}, {});
  await assert.rejects(store.update("local", "n", 0, () => { throw new Error("boom"); }));
  assert.equal(await store.update("local", "n", 0, (n) => n + 1), 1);
});

const profile = { id: ZYWOO, nickname: "ZywOo", avatar: null, level: 10, elo: 3392 };

test("addPlayer appends once and caches the profile", async () => {
  const { areas, store } = memoryStore({ players: [{ id: "x", nickname: "first" }] }, {});
  assert.equal(await addPlayer(store, profile, NOW), AddResult.ADDED);
  assert.equal(await addPlayer(store, profile, NOW), AddResult.EXISTS);
  assert.deepEqual(areas.sync.data.players, [{ id: "x", nickname: "first" }, { id: ZYWOO, nickname: "ZywOo" }]);
  assert.deepEqual(areas.local.data.profiles[ZYWOO], { nickname: "ZywOo", avatar: null, level: 10, elo: 3392, fetchedAt: NOW });
});

test("addPlayer stops at MAX_PLAYERS, under the storage.sync item quota", async () => {
  const players = Array.from({ length: MAX_PLAYERS }, (_, i) => ({ id: `p${i}`, nickname: `player_${i}_xxxxxxxxxxxxxxxxxxx` }));
  const { areas, store } = memoryStore({ players }, {});
  assert.equal(await addPlayer(store, profile, NOW), AddResult.FULL);
  assert.equal(areas.sync.data.players.length, MAX_PLAYERS);
  assert.ok(!(areas.local.data.profiles ?? {})[ZYWOO]);
  // 8192 bytes per item, key included (chrome.storage.sync QUOTA_BYTES_PER_ITEM).
  assert.ok(JSON.stringify(players).length + "players".length < 8192);
});

test("saveHistory returns what to fetch, refreshes elo, skips cached matches", async () => {
  const items = parseHistory(json("history.json"));
  const { areas, store } = memoryStore({}, {});
  await addPlayer(store, { ...profile, elo: 3000 }, NOW);
  await saveMatch(store, items[1].matchId, (prev, t) => scoreboardRecord(prev, parseScoreboard(json("scoreboard.json")), t), NOW);
  const toFetch = await saveHistory(store, ZYWOO, items, NOW);
  assert.equal(toFetch.length, 9);
  assert.ok(!toFetch.includes(items[1].matchId));
  assert.equal(toFetch[0], items[0].matchId, "newest first");
  assert.equal(areas.local.data.profiles[ZYWOO].elo, 3392);
  assert.equal(areas.local.data.history[ZYWOO].items.length, 10);
});

test("saveHistory drops matches that fell out of every history", async () => {
  const { areas, store } = memoryStore({ players: [{ id: ZYWOO, nickname: "ZywOo" }] }, { matches: { old: { status: MatchStatus.OK, crosshairs: {}, attempts: 1 } } });
  await saveHistory(store, ZYWOO, [{ matchId: "new", date: NOW }], NOW);
  assert.deepEqual(Object.keys(areas.local.data.matches), []);
});

test("saveHistory stores nothing for a player who left the board meanwhile", async () => {
  const { areas, store } = memoryStore({ players: [] }, {});
  assert.equal(await saveHistory(store, ZYWOO, [{ matchId: "m", date: NOW }], NOW), null);
  assert.deepEqual(areas.local.data.history ?? {}, {});
});

test("saveHistoryFailure keeps earlier items and marks the time", async () => {
  const { areas, store } = memoryStore({ players: [{ id: ZYWOO, nickname: "ZywOo" }] }, {});
  await saveHistory(store, ZYWOO, [{ matchId: "m", date: NOW }], NOW);
  await saveHistoryFailure(store, ZYWOO, NOW + 1);
  assert.deepEqual(areas.local.data.history[ZYWOO].items.map((i) => i.matchId), ["m"]);
  assert.equal(areas.local.data.history[ZYWOO].failedAt, NOW + 1);
  await saveHistoryFailure(store, "gone", NOW);
  assert.ok(!("gone" in areas.local.data.history));
});

test("removePlayer + pruneLocal drop the player's cache but keep shared matches", async () => {
  const { areas, store } = memoryStore({}, {});
  await addPlayer(store, profile, NOW);
  await addPlayer(store, { id: "p2", nickname: "two" }, NOW);
  await saveHistory(store, ZYWOO, [{ matchId: "shared", date: NOW }, { matchId: "mine", date: NOW }], NOW);
  await saveHistory(store, "p2", [{ matchId: "shared", date: NOW }], NOW);
  for (const id of ["shared", "mine"]) await saveMatch(store, id, noStatsRecord, NOW);

  await removePlayer(store, ZYWOO);
  assert.deepEqual(areas.sync.data.players, [{ id: "p2", nickname: "two" }]);
  await pruneLocal(store);
  assert.deepEqual(Object.keys(areas.local.data.profiles), ["p2"]);
  assert.deepEqual(Object.keys(areas.local.data.history), ["p2"]);
  assert.deepEqual(Object.keys(areas.local.data.matches), ["shared"]);
});

test("pruneLocal reads players in its own step: a quick re-add survives it", async () => {
  const { areas, store } = memoryStore({}, {});
  await addPlayer(store, profile, NOW);
  await removePlayer(store, ZYWOO);
  // The prune for the removal and the re-add race; queue them in the unlucky order.
  const prune = pruneLocal(store);
  const readd = addPlayer(store, profile, NOW + 1);
  await Promise.all([prune, readd]);
  assert.equal(areas.local.data.profiles[ZYWOO]?.fetchedAt, NOW + 1);
});

test("pruneLocal follows players removed by someone else", async () => {
  const { areas, store } = memoryStore({}, {});
  await addPlayer(store, profile, NOW);
  await saveHistory(store, ZYWOO, [{ matchId: "m", date: NOW }], NOW);
  await areas.sync.set({ players: [] }); // e.g. another device via sync
  await pruneLocal(store);
  assert.deepEqual(areas.local.data, { profiles: {}, history: {}, matches: {} });
});
