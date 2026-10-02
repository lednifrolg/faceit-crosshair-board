/* FACEIT Crosshair Board - service worker
 *
 * Owns all network traffic: the new tab page only renders from storage and asks this
 * worker to refresh. Keeping requests in one place is what lets the queue honour FACEIT's
 * rate limits across any number of open tabs. The logic is in lib/worker.js; this file
 * only connects it to chrome.* events.
 *
 * Copyright (C) 2026 Filip Tomasovych
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version. See the LICENSE file for details.
 */

import { ErrorKind, resolveNickname } from "./lib/api.js";
import { SyncKey, AddResult, createStore, addPlayer, removePlayer } from "./lib/store.js";
import { createWorker } from "./lib/worker.js";

const PUMP_ALARM = "pump";
const REFRESH_ALARM = "refresh";
const REFRESH_PERIOD_MIN = 30;
const PLAYERS_PER_REFRESH = 2;

const store = createStore({ sync: chrome.storage.sync, local: chrome.storage.local });

const worker = createWorker({
  store,
  wakeAt: (when) =>
    when == null ? chrome.alarms.clear(PUMP_ALARM) : chrome.alarms.create(PUMP_ALARM, { when }),
});

/* Messages from the new tab page. Each returns `{ ok: true, ... }` or
 * `{ ok: false, error: kind }`; an ApiError never crosses the boundary as an exception. */
const handlers = {
  /** Sent on every new tab; only stale players are queued, so it is cheap to repeat. */
  refresh: async () => ({ ok: true, queued: await worker.refresh() }),

  add: async ({ nickname }) => {
    const { data } = await resolveNickname(nickname);
    const result = await addPlayer(store, data, Date.now()); // onChanged queues its history
    if (result === AddResult.FULL) return { ok: false, error: "board_full" };
    return { ok: true, profile: data, added: result === AddResult.ADDED };
  },

  remove: async ({ id }) => {
    await removePlayer(store, id); // onChanged prunes its cache
    return { ok: true };
  },

  /** A click on a `login` or `error` cell. */
  retry: async ({ matchId }) => {
    await worker.retryMatch(matchId);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg)
    .then(reply)
    .catch((err) => reply({ ok: false, error: err?.kind ?? ErrorKind.HTTP }));
  return true; // reply is async
});

/* `players` can change without this worker's involvement (another synced device, later
 * the profile button), so react to the storage change rather than to our own writes. */
chrome.storage.onChanged.addListener((changes, area) => {
  const change = area === "sync" && changes[SyncKey.PLAYERS];
  if (change) worker.playersChanged(change.oldValue ?? [], change.newValue ?? []);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PUMP_ALARM) worker.pump();
  if (alarm.name === REFRESH_ALARM) worker.refreshStalest(PLAYERS_PER_REFRESH);
});

// Alarms usually survive restarts, but Chrome does not promise it.
chrome.alarms.get(REFRESH_ALARM).then((alarm) => {
  if (!alarm) chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_PERIOD_MIN });
});

// Every wake-up resumes whatever the last instance of this worker left queued.
worker.pump();
