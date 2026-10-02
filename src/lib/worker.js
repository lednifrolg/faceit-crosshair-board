/* FACEIT Crosshair Board - queue runner and refresh policy
 *
 * Everything the service worker does, minus the chrome.* wiring (that is background.js),
 * so the whole flow - history refresh, diff, scoreboard fetches, pacing, failures - runs
 * under `node --test` against a fake fetch and in-memory storage.
 *
 * One request is in flight at a time. Short waits (pacing) are slept through; longer ones
 * hand over to `wakeAt`, an alarm in the extension, since the worker may be killed in
 * between. Whenever jobs are pending an alarm is armed, so a killed worker always resumes.
 *
 * Copyright (C) 2026 Filip Tomasovych
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version. See the LICENSE file for details.
 */

import { ApiError, ErrorKind, getHistory, getPlayer, getScoreboard } from "./api.js";
import {
  LocalKey, SyncKey, MatchStatus, needsFetch, saveHistory, saveHistoryFailure, saveMatch, pruneLocal, profileEntry,
  scoreboardRecord, noStatsRecord, anonymousRecord, errorRecord,
} from "./store.js";
import { QUEUE_KEY, JobType, emptyQueue, enqueue, nextStep, jobDone, jobFailed, historyJob, matchJob } from "./queue.js";

export const HISTORY_STALE_MS = 15 * 60 * 1000;
/** After the queue gave up on a player's history, wait this long before trying again. */
export const HISTORY_FAILED_RETRY_MS = 60 * 60 * 1000;
export const PROFILE_STALE_MS = 24 * 60 * 60 * 1000;
/** Waits up to this long are slept through; the worker stays alive that long when idle. */
export const MAX_SLEEP_MS = 20_000;
/** Safety alarm distance while jobs are pending (Chrome's minimum alarm delay is 30 s). */
export const SAFETY_WAKE_MS = 30_000;

export function createWorker({
  store,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  random = Math.random,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  wakeAt = async () => {},
  timeoutMs, // per request; api.js REQUEST_TIMEOUT_MS when unset
}) {
  const api = { fetchImpl, timeoutMs };

  const updateQueue = (fn) => store.update("local", QUEUE_KEY, emptyQueue(), fn);
  const add = (jobs) => (jobs.length ? updateQueue((q) => enqueue(q, jobs, now())) : null);

  // ------------------------------------------------------------- refresh

  /* When a player's history was last tried, and whether that is long enough ago. A
   * failure counts as a try too, with a longer wait, so a player whose history keeps
   * failing neither costs requests on every tab nor hogs the periodic refresh. */
  const lastTried = (entry) => Math.max(entry?.fetchedAt ?? 0, entry?.failedAt ?? 0);
  function historyDue(entry, t) {
    if (entry?.failedAt && entry.failedAt >= (entry.fetchedAt ?? 0)) return t - entry.failedAt >= HISTORY_FAILED_RETRY_MS;
    return t - (entry?.fetchedAt ?? 0) >= HISTORY_STALE_MS;
  }

  /**
   * Queues a history refresh for every player whose history is due (all of `playerIds`
   * when `force`). Cheap to call from every tab open: fresh players cost nothing and
   * queued ones are deduplicated.
   */
  async function refresh({ playerIds = null, force = false } = {}) {
    const players = await store.read("sync", SyncKey.PLAYERS, []);
    const history = await store.read("local", LocalKey.HISTORY, {});
    const t = now();
    const ids = players
      .map((p) => p.id)
      .filter((id) => !playerIds || playerIds.includes(id))
      .filter((id) => force || historyDue(history[id], t));
    await add(ids.map(historyJob));
    pump();
    return ids.length;
  }

  /** The periodic alarm: refresh the `count` stalest players, so traffic is spread out. */
  async function refreshStalest(count) {
    const players = await store.read("sync", SyncKey.PLAYERS, []);
    const history = await store.read("local", LocalKey.HISTORY, {});
    const t = now();
    const ids = players
      .filter((p) => historyDue(history[p.id], t))
      .map((p) => ({ id: p.id, at: lastTried(history[p.id]) }))
      .sort((a, b) => a.at - b.at)
      .slice(0, count)
      .map((p) => p.id);
    await add(ids.map(historyJob));
    pump();
    return ids;
  }

  /**
   * A click on a `login` or `error` cell: fetch that match now, past the fetch policy
   * (e.g. right after logging in on faceit.com).
   */
  async function retryMatch(matchId) {
    await add([matchJob(matchId, 0, { force: true })]);
    pump();
  }

  /** `players` changed, by this worker or anyone else: fetch newcomers, prune leavers. */
  async function playersChanged(before = [], after = []) {
    const was = new Set(before.map((p) => p.id));
    const is = new Set(after.map((p) => p.id));
    if ([...was].some((id) => !is.has(id))) await pruneLocal(store);
    const added = [...is].filter((id) => !was.has(id));
    if (added.length) await refresh({ playerIds: added, force: true });
  }

  // ---------------------------------------------------------------- jobs

  /** Runs one job. Returns `{ requested, rateLimit }`; throws ApiError on failure. */
  async function run(job) {
    return job.type === JobType.HISTORY ? runHistory(job) : runMatch(job);
  }

  async function runHistory({ playerId }) {
    const players = await store.read("sync", SyncKey.PLAYERS, []);
    const player = players.find((p) => p.id === playerId);
    if (!player) return { requested: false }; // removed while queued

    const { data: items, rateLimit } = await getHistory(playerId, api);
    const toFetch = await saveHistory(store, playerId, items, now());
    if (toFetch == null) return { requested: true, rateLimit }; // removed while in flight
    const rank = new Map(items.map((it, i) => [it.matchId, i]));
    await add(toFetch.map((id) => matchJob(id, rank.get(id))));

    await refreshProfile(player);
    return { requested: true, rateLimit };
  }

  /* Level only comes with the profile, and nicknames can change, so look it up about once
   * a day. Best effort: the history already succeeded, so a failure here is not the job's. */
  async function refreshProfile(player) {
    const profiles = await store.read("local", LocalKey.PROFILES, {});
    if (now() - (profiles[player.id]?.fetchedAt ?? 0) < PROFILE_STALE_MS) return;
    let profile;
    try {
      ({ data: profile } = await getPlayer(player.id, api));
    } catch {
      return;
    }
    // Also creates the entry for players added elsewhere (sync, the profile button), but
    // not for one removed while the lookup was in flight.
    await store.update("local", LocalKey.PROFILES, {}, async (all) => {
      const players = await store.read("sync", SyncKey.PLAYERS, []);
      return players.some((p) => p.id === player.id) ? { ...all, [player.id]: profileEntry(profile, now()) } : all;
    });
    if (profile.nickname !== player.nickname) {
      await store.update("sync", SyncKey.PLAYERS, [], (list) =>
        list.map((p) => (p.id === player.id ? { ...p, nickname: profile.nickname } : p))
      );
    }
  }

  async function runMatch({ matchId, force }) {
    const history = await store.read("local", LocalKey.HISTORY, {});
    const matches = await store.read("local", LocalKey.MATCHES, {});
    const item = Object.values(history).flatMap((h) => h.items ?? []).find((it) => it.matchId === matchId);
    // Gone from every history (player removed, or it aged out), or fetched by now. A forced
    // job still never refetches an `ok` match: its crosshairs can't change.
    if (!item) return { requested: false };
    const match = matches[matchId];
    if (force ? match?.status === MatchStatus.OK : !needsFetch(match, item, now())) return { requested: false };

    try {
      const { data, rateLimit } = await getScoreboard(matchId, api);
      await saveMatch(store, matchId, (prev, t) => scoreboardRecord(prev, data, t), now());
      return { requested: true, rateLimit };
    } catch (err) {
      // Answers about the match, not failures of the request.
      if (err?.kind === ErrorKind.NOT_FOUND) {
        await saveMatch(store, matchId, noStatsRecord, now());
        return { requested: true, rateLimit: err.rateLimit };
      }
      if (err?.kind === ErrorKind.ANONYMOUS) {
        await saveMatch(store, matchId, anonymousRecord, now());
        return { requested: true, rateLimit: err.rateLimit };
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- pump

  let running = null;
  let again = false;

  /** Drains the queue. Concurrent calls coalesce into the one already running. */
  function pump() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await drain();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  /* An alarm is always armed while jobs are pending, so a killed worker resumes; it is
   * re-armed only when it would fire too soon or at the wrong time, not before every job. */
  let armedAt;
  async function arm(when) {
    if (when === armedAt) return;
    armedAt = when;
    await wakeAt(when);
  }

  async function drain() {
    for (;;) {
      const queue = await store.read("local", QUEUE_KEY, emptyQueue());
      const t = now();
      const step = nextStep(queue, t);
      if (step.idle) {
        await arm(null);
        return;
      }
      if (step.waitUntil) {
        if (step.waitUntil - t > MAX_SLEEP_MS) {
          await arm(step.waitUntil); // the alarm takes it from here
          return;
        }
        if (armedAt == null || armedAt < step.waitUntil) await arm(Math.max(step.waitUntil, t + SAFETY_WAKE_MS));
        await sleep(step.waitUntil - t);
        continue;
      }
      if (armedAt == null || armedAt < t + SAFETY_WAKE_MS / 2) await arm(t + SAFETY_WAKE_MS);

      const { job } = step;
      try {
        const result = await run(job);
        await updateQueue((q) => jobDone(q, job, result, now()));
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError(ErrorKind.HTTP, { cause: err });
        let dropped = false;
        await updateQueue((q) => {
          const out = jobFailed(q, job, e, now(), random);
          dropped = out.dropped;
          return out.queue;
        });
        // Remember the give-up, or the next refresh would queue it all over again.
        if (dropped && job.type === JobType.MATCH) await saveMatch(store, job.matchId, errorRecord, now());
        if (dropped && job.type === JobType.HISTORY) await saveHistoryFailure(store, job.playerId, now());
      }
    }
  }

  return { refresh, refreshStalest, retryMatch, playersChanged, pump };
}
