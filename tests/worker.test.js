// SPDX-License-Identifier: GPL-3.0-or-later
//
// The whole refresh flow against a fake FACEIT: what goes out, in what order, how often.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorker, HISTORY_STALE_MS, HISTORY_FAILED_RETRY_MS, MAX_SLEEP_MS } from "../src/lib/worker.js";
import { QUEUE_KEY, Condition, enqueue, emptyQueue, historyJob, conditionOf } from "../src/lib/queue.js";
import { MatchStatus, NONE_RETRY_SPACING_MS, ERROR_RETRY_LIMIT, ERROR_RETRY_SPACING_MS, ANONYMOUS_RETRY_SPACING_MS, rowCells, CellState } from "../src/lib/store.js";
import { fakeFetch, memoryStore, fixture } from "./helpers.js";

const MIN = 60 * 1000;
const H = 60 * MIN;
const SCOREBOARD_RL = { "content-type": "application/json", "ratelimit-limit": "5, 5;w=30", "ratelimit-remaining": "4" };
const CHALLENGE = { status: 403, headers: { "content-type": "text/html", "cf-mitigated": "challenge" }, body: fixture("challenge.html") };

/** A small fake FACEIT whose histories and per-match answers tests can change. */
function fakeFaceit(clock) {
  const histories = {}; // playerId -> [matchId] newest first
  const nicknames = {};
  const overrides = {}; // matchId -> [spec, ...] consumed one per request, then the default
  const historyItem = (matchId) => ({ matchId, date: clock.t - 1 * H, i1: "de_nuke", i18: "13 / 7", elo: "2000", elo_delta: "12" });
  const scoreboard = (matchId) => ({
    payload: {
      id: matchId,
      cs2: { teams: [{ score: 13, players: Object.keys(histories).map((id) => ({ player_id: id, crosshair: `CODE-${id}` })) }, { score: 7, players: [] }] },
    },
  });
  const { impl, calls } = fakeFetch((path) => {
    let m;
    if ((m = /^\/stats\/v1\/stats\/time\/users\/([^/]+)\/games\/cs2/.exec(path))) {
      return { body: (histories[m[1]] ?? []).map(historyItem) };
    }
    if ((m = /^\/users\/v1\/users\/([^/?]+)$/.exec(path))) {
      return { body: { payload: { id: m[1], nickname: nicknames[m[1]] ?? m[1], games: { cs2: { skill_level: 10, faceit_elo: 2000 } } } } };
    }
    if ((m = /^\/statistics\/v1\/cs2\/matches\/([^/]+)\//.exec(path))) {
      const queued = overrides[m[1]];
      if (queued?.length) return queued.shift();
      return { headers: SCOREBOARD_RL, body: scoreboard(m[1]) };
    }
  });
  const scoreboardCalls = () => calls.filter((c) => c.path.startsWith("/statistics/")).map((c) => /matches\/([^/]+)\//.exec(c.path)[1]);
  const historyCalls = () => calls.filter((c) => c.path.startsWith("/stats/")).length;
  return { histories, nicknames, overrides, impl, calls, scoreboardCalls, historyCalls };
}

function setup({ players = ["pa", "pb"], timeoutMs } = {}) {
  const clock = { t: Date.parse("2026-10-02T12:00:00Z") };
  const faceit = fakeFaceit(clock);
  const { areas, store } = memoryStore({ players: players.map((id) => ({ id, nickname: id })) }, {});
  const wakes = [];
  const worker = createWorker({
    store,
    fetchImpl: faceit.impl,
    now: () => clock.t,
    random: () => 0.5,
    sleep: async (ms) => { clock.t += ms; },
    wakeAt: async (when) => { wakes.push(when); },
    timeoutMs,
  });
  const local = () => areas.local.data;
  const start = async () => {
    await worker.playersChanged([], areas.sync.data.players);
    await worker.pump();
  };
  return { clock, faceit, areas, store, worker, wakes, local, start };
}

const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test("cold fill: one history per player, each shared match fetched once, newest first", async () => {
  const s = setup();
  s.faceit.histories.pa = ["shared", ...ids("a", 9)];
  s.faceit.histories.pb = ["b0", "shared", ...ids("b", 10).slice(1, 9)];
  await s.start();

  assert.equal(s.faceit.historyCalls(), 2);
  const sb = s.faceit.scoreboardCalls();
  assert.equal(sb.length, 19, "10 + 10 minus the shared one");
  assert.equal(new Set(sb).size, sb.length, "nothing fetched twice");
  assert.deepEqual(new Set(sb.slice(0, 2)), new Set(["shared", "b0"]), "every player's newest match first");
  assert.deepEqual(s.local().queue.jobs, []);
  assert.equal(s.local().matches.shared.status, MatchStatus.OK);
  assert.equal(s.local().matches.shared.crosshairs.pb, "CODE-pb", "crosshairs of everyone in the match are kept");
  const cells = rowCells("pa", s.local().history.pa, s.local().matches, s.clock.t);
  assert.ok(cells.every((c) => c.state === CellState.CODE));
});

test("scoreboard requests are paced from the rate-limit headers", async () => {
  const s = setup({ players: ["pa"] });
  s.faceit.histories.pa = ids("a", 4);
  const at = [];
  const inner = s.faceit.impl;
  const worker = createWorker({
    store: s.store,
    fetchImpl: (url, init) => {
      if (url.includes("/statistics/")) at.push(s.clock.t);
      return inner(url, init);
    },
    now: () => s.clock.t,
    sleep: async (ms) => { s.clock.t += ms; },
  });
  await worker.playersChanged([], s.areas.sync.data.players);
  await worker.pump();
  assert.equal(at.length, 4);
  // ratelimit-limit 5 per 30 s -> 6 s apart
  assert.deepEqual(at.slice(1).map((t, i) => t - at[i]), [6000, 6000, 6000]);
});

test("refresh after one new match sends exactly one scoreboard request", async () => {
  const s = setup();
  s.faceit.histories.pa = ids("a", 10);
  s.faceit.histories.pb = ids("b", 10);
  await s.start();
  const before = s.faceit.calls.length;

  s.clock.t += HISTORY_STALE_MS + 1;
  s.faceit.histories.pa = ["new", ...ids("a", 9)]; // a9 fell out of the last 10
  await s.worker.refresh();
  await s.worker.pump();

  const after = s.faceit.calls.slice(before);
  assert.equal(after.filter((c) => c.path.startsWith("/stats/")).length, 2, "both players were stale");
  assert.deepEqual(after.filter((c) => c.path.startsWith("/statistics/")).map((c) => /matches\/([^/]+)\//.exec(c.path)[1]), ["new"]);
  assert.ok(!("a9" in s.local().matches), "matches out of every history are collected");
});

test("refresh within 15 minutes costs nothing, and many tabs coalesce", async () => {
  const s = setup();
  s.faceit.histories.pa = ids("a", 2);
  s.faceit.histories.pb = ids("b", 2);
  await s.start();
  const before = s.faceit.calls.length;
  const fetchedAt = s.local().history.pa.fetchedAt;
  s.clock.t = fetchedAt + HISTORY_STALE_MS - 1;
  await Promise.all([s.worker.refresh(), s.worker.refresh(), s.worker.refresh()]);
  await s.worker.pump();
  assert.equal(s.faceit.calls.length, before);

  s.clock.t = s.local().history.pb.fetchedAt + HISTORY_STALE_MS;
  await Promise.all([s.worker.refresh(), s.worker.refresh(), s.worker.refresh()]);
  await s.worker.pump();
  assert.equal(s.faceit.calls.length - before, 2, "one history request per player, not per tab");
});

test("refreshStalest picks the oldest histories", async () => {
  const s = setup({ players: ["pa", "pb", "pc"] });
  for (const p of ["pa", "pb", "pc"]) s.faceit.histories[p] = [];
  await s.start();
  s.clock.t += HISTORY_STALE_MS;
  await s.worker.refresh({ playerIds: ["pb"], force: true });
  await s.worker.pump();
  s.clock.t += 1;
  assert.deepEqual(new Set(await s.worker.refreshStalest(2)), new Set(["pa", "pc"]));
});

test("no stats: 404 is retried on later refreshes, at most three times", async () => {
  const s = setup({ players: ["pa"] });
  s.faceit.histories.pa = ["m"];
  const notFound = { status: 404, headers: { "content-type": "application/json" }, body: fixture("error-not-found.json") };
  s.faceit.overrides.m = [notFound, notFound, notFound, notFound];
  await s.start();
  for (let i = 0; i < 5; i++) {
    s.clock.t += NONE_RETRY_SPACING_MS;
    // keep the match young enough for retries: its date follows the fake clock
    await s.worker.refresh({ force: true });
    await s.worker.pump();
  }
  assert.equal(s.faceit.scoreboardCalls().length, 3);
  assert.equal(s.local().matches.m.status, MatchStatus.NONE);
  assert.equal(s.local().matches.m.attempts, 3);
});

test("err_f0 is stored as anonymous and never asked again", async () => {
  const s = setup({ players: ["pa"] });
  s.faceit.histories.pa = ["m"];
  s.faceit.overrides.m = [{ status: 403, headers: { "content-type": "application/json" }, body: fixture("error-anonymous.json") }];
  await s.start();
  s.clock.t += HISTORY_STALE_MS;
  await s.worker.refresh();
  await s.worker.pump();
  assert.equal(s.local().matches.m.status, MatchStatus.ANONYMOUS);
  assert.equal(s.faceit.scoreboardCalls().length, 1);
});

test("429 waits for retry-after, then the same match succeeds", async () => {
  const s = setup({ players: ["pa"] });
  s.faceit.histories.pa = ["m"];
  s.faceit.overrides.m = [{ status: 429, headers: { "content-type": "application/json", "ratelimit-retry-after": "15" }, body: "{}" }];
  await s.start();
  assert.deepEqual(s.faceit.scoreboardCalls(), ["m", "m"]);
  assert.equal(s.local().matches.m.status, MatchStatus.OK);
  assert.equal(conditionOf(s.local().queue), null);
});

test("challenges: blocked after three in a row, recovers on its own, never drops the match", async () => {
  const s = setup({ players: ["pa"] });
  s.faceit.histories.pa = ["m"];
  s.faceit.overrides.m = [CHALLENGE, CHALLENGE, CHALLENGE];
  await s.worker.playersChanged([], s.areas.sync.data.players);
  await s.worker.pump(); // sleeps through the 10 s and 20 s backoffs, then hands over at 40 s
  assert.equal(conditionOf(s.local().queue), Condition.BLOCKED);
  assert.ok(s.wakes.at(-1) > s.clock.t + MAX_SLEEP_MS, "an alarm resumes it");

  s.clock.t = s.wakes.at(-1);
  await s.worker.pump(); // the alarm fired
  assert.equal(s.local().matches.m.status, MatchStatus.OK);
  assert.equal(conditionOf(s.local().queue), null);
  assert.deepEqual(s.faceit.scoreboardCalls(), ["m", "m", "m", "m"]);
  assert.equal(s.wakes.at(-1), null, "alarm cleared once idle");
});

test("offline: the queue survives a dead network and resumes", async () => {
  const s = setup({ players: ["pa"] });
  s.faceit.histories.pa = ["m"];
  s.faceit.overrides.m = [new TypeError("Failed to fetch")];
  await s.start();
  assert.equal(s.local().matches.m.status, MatchStatus.OK);
  assert.deepEqual(s.faceit.scoreboardCalls(), ["m", "m"]);
});

test("a player removed while queued costs no further requests", async () => {
  const s = setup();
  s.faceit.histories.pa = ids("a", 10);
  s.faceit.histories.pb = ids("b", 10);
  await s.worker.playersChanged([], s.areas.sync.data.players);
  // Before pumping: drop pb as another device would.
  const before = s.areas.sync.data.players;
  await s.areas.sync.set({ players: before.filter((p) => p.id !== "pb") });
  await s.worker.playersChanged(before, s.areas.sync.data.players);
  await s.worker.pump();
  assert.equal(s.faceit.historyCalls(), 1);
  assert.ok(s.faceit.scoreboardCalls().every((id) => id.startsWith("a")));
  assert.deepEqual(Object.keys(s.local().history), ["pa"]);
});

test("a nickname change on FACEIT is picked up from the daily profile lookup", async () => {
  const s = setup({ players: ["pa"] });
  s.faceit.histories.pa = [];
  s.faceit.nicknames.pa = "renamed";
  await s.start();
  assert.equal(s.areas.sync.data.players[0].nickname, "renamed");
});

test("the queue is resumable: a new worker instance continues where one stopped", async () => {
  const s = setup({ players: ["pa"] });
  s.faceit.histories.pa = ids("a", 3);
  // What a worker killed right after queueing leaves behind: just the persisted queue.
  await s.areas.local.set({ [QUEUE_KEY]: enqueue(emptyQueue(), [historyJob("pa")], s.clock.t) });
  await s.worker.pump();
  assert.equal(s.faceit.historyCalls(), 1);
  assert.equal(s.faceit.scoreboardCalls().length, 3);
  assert.deepEqual(s.local()[QUEUE_KEY].jobs, []);
});

test("a player removed while their history request is in flight leaves nothing behind", async () => {
  const s = setup();
  s.faceit.histories.pa = ids("a", 3);
  s.faceit.histories.pb = ids("b", 3);
  // pb's history answers only after pb was removed (as a click on [x] would do).
  const inner = s.faceit.impl;
  let release;
  const gate = new Promise((r) => (release = r));
  const worker = createWorker({
    store: s.store,
    now: () => s.clock.t,
    sleep: async (ms) => { s.clock.t += ms; },
    fetchImpl: async (url, init) => {
      if (url.includes("/users/pb/")) await gate;
      return inner(url, init);
    },
  });
  await worker.playersChanged([], s.areas.sync.data.players);
  const pumping = worker.pump();
  while (!s.faceit.calls.length && !s.local().history?.pa) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 50 && !s.faceit.calls.some((c) => c.path.includes("/users/pb/")); i++) await new Promise((r) => setImmediate(r));
  const before = s.areas.sync.data.players;
  await s.areas.sync.set({ players: before.filter((p) => p.id !== "pb") });
  await worker.playersChanged(before, s.areas.sync.data.players);
  release();
  await pumping;
  await worker.pump();
  assert.ok(s.faceit.calls.some((c) => c.path.includes("/users/pb/")), "pb's request did go out");
  assert.deepEqual(Object.keys(s.local().history), ["pa"], "no orphan history");
  assert.ok(s.faceit.scoreboardCalls().every((id) => id.startsWith("a")), "pb's matches never fetched");
});

test("a match that keeps failing is recorded, not re-queued on every refresh", async () => {
  const s = setup({ players: ["pa"] });
  s.faceit.histories.pa = ["bad"];
  const fail = { status: 500, headers: { "content-type": "application/json" }, body: "{}" };
  s.faceit.overrides.bad = Array(50).fill(fail);
  await s.start();
  assert.equal(s.local().matches.bad.status, MatchStatus.ERROR);
  const afterFirst = s.faceit.scoreboardCalls().length;
  assert.equal(afterFirst, 3, "the job's three tries");

  for (let i = 0; i < 4; i++) {
    s.clock.t += HISTORY_STALE_MS; // refreshes inside the error retry spacing cost nothing
    await s.worker.refresh();
    await s.worker.pump();
  }
  assert.ok(s.faceit.scoreboardCalls().length <= afterFirst + 3, "at most one more round in that hour");

  for (let i = 0; i < 10; i++) {
    s.clock.t += ERROR_RETRY_SPACING_MS;
    await s.worker.refresh({ force: true });
    await s.worker.pump();
  }
  assert.equal(s.faceit.scoreboardCalls().length, 3 * ERROR_RETRY_LIMIT, "then it is final");
  const cell = rowCells("pa", s.local().history.pa, s.local().matches, s.clock.t)[0];
  assert.deepEqual([cell.state, cell.final], [CellState.ERROR, true]);
});

test("a player whose history keeps failing doesn't hog the periodic refresh", async () => {
  const s = setup({ players: ["broken", "pa", "pb"] });
  s.faceit.histories.pa = [];
  s.faceit.histories.pb = [];
  const realImpl = s.faceit.impl;
  const worker = createWorker({
    store: s.store,
    now: () => s.clock.t,
    sleep: async (ms) => { s.clock.t += ms; },
    fetchImpl: (url, init) =>
      url.includes("/users/broken/games")
        ? Promise.resolve(new Response("{}", { status: 500, headers: { "content-type": "application/json" } }))
        : realImpl(url, init),
  });
  await worker.playersChanged([], s.areas.sync.data.players);
  await worker.pump();
  assert.ok(s.local().history.broken.failedAt, "the give-up is recorded");
  assert.equal(rowCells("broken", s.local().history.broken, {}, s.clock.t)[0].state, CellState.ERROR);

  s.clock.t += HISTORY_STALE_MS + 1;
  assert.deepEqual(new Set(await worker.refreshStalest(2)), new Set(["pa", "pb"]), "broken waits for its longer retry");
  await worker.pump();
  s.clock.t += HISTORY_FAILED_RETRY_MS;
  assert.ok((await worker.refreshStalest(2)).includes("broken"), "and is tried again after it");
});

test("a stalled request times out and the queue moves on", async () => {
  const s = setup({ players: ["pa"], timeoutMs: 30 });
  s.faceit.histories.pa = ["m"];
  s.faceit.overrides.m = [{ hang: true }];
  await s.start();
  assert.equal(s.local().matches.m.status, MatchStatus.OK, "retried after the network backoff");
  assert.deepEqual(s.faceit.scoreboardCalls(), ["m", "m"]);
});

test("retryMatch fetches an anonymous match right away, past the fetch policy", async () => {
  const s = setup({ players: ["pa"] });
  s.faceit.histories.pa = ["m"];
  s.faceit.overrides.m = [{ status: 403, headers: { "content-type": "application/json" }, body: fixture("error-anonymous.json") }];
  await s.start();
  assert.equal(s.local().matches.m.status, MatchStatus.ANONYMOUS);
  // Logged in on faceit.com now; the next answer has stats.
  await s.worker.retryMatch("m");
  await s.worker.pump();
  assert.equal(s.local().matches.m.status, MatchStatus.OK);
  assert.deepEqual(s.faceit.scoreboardCalls(), ["m", "m"]);
  await s.worker.retryMatch("m"); // ok is final even when forced
  await s.worker.pump();
  assert.equal(s.faceit.scoreboardCalls().length, 2);
});

test("anonymous matches are retried by refreshes after their spacing", async () => {
  const s = setup({ players: ["pa"] });
  s.faceit.histories.pa = ["m"];
  s.faceit.overrides.m = [{ status: 403, headers: { "content-type": "application/json" }, body: fixture("error-anonymous.json") }];
  await s.start();
  s.clock.t += ANONYMOUS_RETRY_SPACING_MS;
  await s.worker.refresh({ force: true });
  await s.worker.pump();
  assert.equal(s.local().matches.m.status, MatchStatus.OK);
});

test("the safety alarm is not re-armed before every job", async () => {
  const s = setup({ players: ["pa"] });
  s.faceit.histories.pa = ids("a", 10);
  await s.start();
  assert.equal(s.faceit.scoreboardCalls().length, 10);
  assert.ok(s.wakes.length < 10, `armed ${s.wakes.length} times for 11 jobs`);
  assert.equal(s.wakes.at(-1), null, "cleared when idle");
});
