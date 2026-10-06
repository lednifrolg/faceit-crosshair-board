/* FACEIT Crosshair Board - new tab page
 *
 * Renders from storage only and never touches the network itself; the service worker
 * owns every request (see background.js). Opening a tab asks the worker to refresh, which
 * only costs requests for players whose history is stale.
 *
 * Copyright (C) 2026 Filip Tomasovych
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version. See the LICENSE file for details.
 */

import { ErrorKind } from "./lib/api.js";
import { SyncKey, LocalKey, CellState, MATCHES_PER_PLAYER, MAX_PLAYERS, rowCells } from "./lib/store.js";
import { QUEUE_KEY, Condition, emptyQueue, conditionOf } from "./lib/queue.js";
import { renderCode, crosshairKey } from "./crosshair.js";

const COPIED_MS = 900;
const ADD_MESSAGE_MS = 6000;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const boardEl = $("board");
const tipEl = $("tip");
const addForm = $("add");
const addInput = $("add-input");
const addMsg = $("add-msg");

const state = { players: [], profiles: {}, history: {}, matches: {}, queue: emptyQueue() };

/* Storage key -> state field. `board` says whether a change to it can change the grid;
 * the queue only feeds the status line and is written several times per request. */
const FIELDS = {
  sync: { [SyncKey.PLAYERS]: { field: "players", empty: () => [], board: true } },
  local: {
    [LocalKey.PROFILES]: { field: "profiles", empty: () => ({}), board: true },
    [LocalKey.HISTORY]: { field: "history", empty: () => ({}), board: true },
    [LocalKey.MATCHES]: { field: "matches", empty: () => ({}), board: true },
    [QUEUE_KEY]: { field: "queue", empty: emptyQueue, board: false },
  },
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// ------------------------------------------------------------------ formatting

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const pad = (n) => String(n).padStart(2, "0");
function stamp(epochMs) {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fixed2 = (v) => (v == null ? "?" : v.toFixed(2));
const whole = (v) => (v == null ? "?" : String(Math.round(v)));

/** "rating 1.26 · K/D/A 21/13/4 · ADR 108 · HS 67%", in the match room's K/D/A order. */
function statsLine(s) {
  const parts = [`K/D/A ${s.kills}/${s.deaths}/${s.assists ?? "?"}`, `ADR ${whole(s.adr)}`];
  if (s.rating != null) parts.unshift(`rating ${fixed2(s.rating)}`);
  if (s.hs != null) parts.push(`HS ${whole(s.hs)}%`);
  return parts.join(" · ");
}

/** "this crosshair   6 matches  rating 1.30  ADR  85", for combineStats output. Padded
 * so the lines of the tooltip line up as a table. */
const combinedLine = (label, c) =>
  [label.padEnd(14), `${String(c.matches).padStart(2)} ${c.matches === 1 ? "match  " : "matches"}`,
    `rating ${fixed2(c.rating)}`, `ADR ${whole(c.adr).padStart(3)}`].join("  ");

const profileUrl = (nickname) => `https://www.faceit.com/en/players/${encodeURIComponent(nickname)}`;

// --------------------------------------------------------------------- status

const CONDITION_TEXT = {
  [Condition.RATE_LIMITED]: "rate limited by faceit.com, waiting",
  [Condition.CHALLENGE]: "faceit.com challenged a request, retrying",
  [Condition.BLOCKED]: "blocked by faceit.com, retrying every few minutes",
  [Condition.OFFLINE]: "offline, retrying",
};

function renderStatus() {
  const { queue } = state;
  const condition = conditionOf(queue);
  const parts = [];
  if (condition) parts.push(CONDITION_TEXT[condition] ?? condition);
  else if (queue.lastSuccessAt) parts.push(`synced ${ago(Date.now() - queue.lastSuccessAt)}`);
  else parts.push(state.players.length ? "syncing" : "ready");
  if (queue.jobs.length) parts.push(`queue ${queue.jobs.length}`);
  statusEl.textContent = parts.join(" · ");
  statusEl.classList.toggle("trouble", Boolean(condition));
}

// ---------------------------------------------------------------------- cells

const cellInfo = new WeakMap(); // node -> { cell, nickname }

/** Cell states that a click retries (via the worker's `retry` message). */
const RETRYABLE = new Set([CellState.ANONYMOUS, CellState.ERROR]);

const CELL_TEXT = {
  [CellState.NO_CODE]: ["no code", "no crosshair was recorded for this player in this match"],
  [CellState.PENDING]: ["pending", "no stats yet: FACEIT may still be parsing this match, checking again later"],
  [CellState.NO_STATS]: ["no stats", "FACEIT has no advanced stats for this match"],
  [CellState.ANONYMOUS]: ["login", "FACEIT shows this match's stats only when you are logged in on faceit.com. Log in there, then click to retry"],
  [CellState.ERROR]: ["error", "FACEIT kept failing on this match, retrying later. Click to retry now"],
  [CellState.LOADING]: [null, "loading"],
};

function cellTip(cell) {
  if (cell.history) {
    return cell.state === CellState.ERROR ? "couldn't load this player's matches, retrying later" : "loading this player's matches";
  }
  if (cell.state === CellState.ERROR && cell.final) return "FACEIT kept failing on this match. Click to retry";
  return CELL_TEXT[cell.state]?.[1] ?? "";
}

/* Matches a click asked the worker to retry, with the attempt time they had then; such a
 * cell shows as loading until the match record moves on, whatever the outcome. */
const retrying = new Map(); // matchId -> lastAttemptAt at click time

function isRetrying(matchId) {
  if (!retrying.has(matchId)) return false;
  if (state.matches[matchId]?.lastAttemptAt !== retrying.get(matchId)) {
    retrying.delete(matchId);
    return false;
  }
  return true;
}

/* Keys must be unique within a render: two cells sharing one would get the same node, the
 * grid would lose a child and every later cell would slide one column over. The column
 * index guarantees that even for a history that lists a match twice. */
function cellKey(playerId, cell, i) {
  if (cell.state === CellState.EMPTY || cell.history) return `${playerId}|${cell.state}|${i}`;
  return `${playerId}|${i}|${cell.matchId}|${cell.state}|${cell.code}|${cell.changed}|${cell.final}|${cell.stats?.rating}`;
}

/* The player's FACEIT Rating in that match, in the corner: how a crosshair went at a
 * glance. 1.00 is FACEIT's average. */
function ratingBadge(stats) {
  if (stats?.rating == null) return null;
  const badge = el("span", "rating", fixed2(stats.rating));
  badge.classList.toggle("low", stats.rating < 1);
  badge.setAttribute("aria-hidden", "true");
  return badge;
}

function cellNode(cell, nickname, isLatest) {
  const node = el("button", "cell");
  node.type = "button";
  cellInfo.set(node, { cell, nickname });

  if (cell.state === CellState.EMPTY) {
    node.classList.add("empty");
    node.disabled = true;
    node.tabIndex = -1;
    node.setAttribute("aria-hidden", "true");
    return node;
  }
  const badge = cell.history ? null : ratingBadge(cell.stats);
  if (cell.state === CellState.LOADING) {
    node.classList.add("loading");
    node.setAttribute("aria-label", "loading");
  } else if (cell.state !== CellState.CODE) {
    node.textContent = CELL_TEXT[cell.state][0];
    if (cell.state === CellState.PENDING) node.classList.add("pending");
    if (RETRYABLE.has(cell.state) && cell.matchId) node.classList.add("retry");
  } else {
    node.classList.add("has-code");
    if (cell.changed === true) node.classList.add("changed");
    if (cell.changed === false && !isLatest) node.classList.add("same");
    node.setAttribute("aria-label", `copy ${cell.code}${cell.stats?.rating != null ? `, rating ${fixed2(cell.stats.rating)}` : ""}`);
    const art = renderCode(cell.code);
    if (art.canvas) node.append(art.canvas);
    else node.textContent = art.text;
  }
  if (badge) node.append(badge);
  return node;
}

// ---------------------------------------------------------------------- board

function playerHead({ id, nickname }, profile) {
  const head = el("div", "player");

  const nick = el("a", "nick", nickname);
  nick.href = profileUrl(nickname);
  nick.target = "_blank";
  nick.rel = "noopener";
  nick.title = `${nickname} on faceit.com`;

  const meta = el("div", "meta");
  if (profile?.level != null || profile?.elo != null) {
    meta.append("lvl ", el("span", "num", profile.level ?? "?"), " · ", el("span", "num", profile.elo ?? "?"), " elo");
  } else {
    meta.textContent = "…";
  }

  const remove = el("button", "remove", "[x]");
  remove.type = "button";
  remove.title = `remove ${nickname}`;
  remove.setAttribute("aria-label", `remove ${nickname}`);
  remove.addEventListener("click", () => removePlayer(id, nickname));

  head.append(nick, meta, remove);
  return head;
}

/* The grid is patched, not rebuilt: nodes are keyed by what they show, and only nodes
 * whose key changed are created, inserted or removed. Everything else stays in the
 * document untouched, so a write every few seconds during a fill keeps keyboard focus,
 * hover, a half-done click and a COPIED flash intact. */
let grid = null;
let nodes = new Map(); // key -> node

function boardChildren() {
  const now = Date.now();
  const out = [];
  const keep = (key, make) => out.push([key, nodes.get(key) ?? make()]);

  keep("colhead|corner", () => el("div", "colhead corner", ""));
  keep("colhead|latest", () => el("div", "colhead", "latest"));
  for (let i = 2; i < MATCHES_PER_PLAYER; i++) keep(`colhead|${i}`, () => el("div", "colhead", ""));
  keep("colhead|oldest", () => el("div", "colhead oldest", "oldest"));

  for (const player of state.players) {
    const profile = state.profiles[player.id];
    keep(`player|${player.id}|${player.nickname}|${profile?.level}|${profile?.elo}`, () => playerHead(player, profile));
    rowCells(player.id, state.history[player.id], state.matches, now, crosshairKey).forEach((cell, i) => {
      if (cell.matchId && isRetrying(cell.matchId)) cell = { ...cell, state: CellState.LOADING };
      const key = cellKey(player.id, cell, i);
      // A kept node still gets the fresh cell: its per-crosshair stats move with the row.
      if (nodes.has(key)) cellInfo.set(nodes.get(key), { cell, nickname: player.nickname });
      keep(key, () => cellNode(cell, player.nickname, i === 0));
    });
  }
  return out;
}

function renderBoard() {
  if (!state.players.length) {
    grid = null;
    nodes = new Map();
    boardEl.replaceChildren(el("p", "empty-board", "no players yet. type a faceit nickname above and press enter."));
    hideTip();
    return;
  }
  if (!grid) {
    grid = el("div", "grid");
    boardEl.replaceChildren(grid);
  }

  const wanted = boardChildren();
  const wantedNodes = new Set(wanted.map(([, node]) => node));
  for (const child of [...grid.children]) if (!wantedNodes.has(child)) child.remove();
  // What's left is already in order, so only new nodes get inserted; none is moved.
  let cursor = grid.firstElementChild;
  for (const [, node] of wanted) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else grid.insertBefore(node, cursor);
  }
  nodes = new Map(wanted);
  if (tipAnchor && !tipAnchor.isConnected) hideTip();
}

// -------------------------------------------------------------------- tooltip

let tipAnchor = null;

function tipLines({ cell }) {
  if (cell.history) return [["tip-hint", cellTip(cell)]];
  const lines = [];
  lines.push(["tip-head", [cell.map, cell.score].filter(Boolean).join(" · ") || "match"]);
  if (cell.date) lines.push([null, `${stamp(cell.date)} (${ago(Date.now() - cell.date)})`]);
  if (cell.stats) lines.push(["tip-stats", statsLine(cell.stats)]);
  if (cell.state === CellState.CODE) {
    lines.push(["tip-code", cell.code]);
    if (cell.changed) lines.push(["tip-new", "changed since the match before"]);
    // Only worth a line when it says more than this match's own stats.
    if (cell.withCrosshair && (cell.withCrosshair.matches > 1 || cell.withOthers)) {
      lines.push(["tip-sum", combinedLine("this crosshair", cell.withCrosshair)]);
      if (cell.withOthers) lines.push(["tip-sum", combinedLine("other ones", cell.withOthers)]);
    }
    lines.push(["tip-hint", "click to copy"]);
  } else {
    lines.push(["tip-hint", cellTip(cell)]);
  }
  return lines;
}

function showTip(anchor) {
  const info = cellInfo.get(anchor);
  if (!info || info.cell.state === CellState.EMPTY) return hideTip();
  tipAnchor = anchor;
  tipEl.replaceChildren(...tipLines(info).map(([cls, text]) => el("div", cls, text)));
  tipEl.hidden = false;

  const r = anchor.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = r.top - h - 8;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  tipEl.style.top = `${Math.max(8, top)}px`;
  tipEl.style.left = `${left}px`;
}

function hideTip() {
  tipAnchor = null;
  tipEl.hidden = true;
}

boardEl.addEventListener("pointerover", (e) => {
  const cell = e.target.closest?.(".cell");
  if (cell && cell !== tipAnchor) showTip(cell);
});
boardEl.addEventListener("pointerleave", hideTip);
boardEl.addEventListener("pointerout", (e) => {
  if (!e.relatedTarget?.closest?.(".cell")) hideTip();
});
boardEl.addEventListener("focusin", (e) => {
  if (e.target.matches?.(".cell")) showTip(e.target);
});
boardEl.addEventListener("focusout", hideTip);
boardEl.addEventListener("scroll", hideTip);
window.addEventListener("scroll", hideTip, { passive: true });

// ---------------------------------------------------------------- copy, retry

const copyTimers = new WeakMap();

boardEl.addEventListener("click", (e) => {
  const node = e.target.closest?.(".cell");
  const info = node && cellInfo.get(node);
  if (!info) return;
  const { cell } = info;

  if (cell.state === CellState.CODE) {
    navigator.clipboard
      .writeText(cell.code)
      .then(() => {
        clearTimeout(copyTimers.get(node));
        node.classList.add("copied");
        copyTimers.set(node, setTimeout(() => node.classList.remove("copied"), COPIED_MS));
      })
      .catch(() => {}); // rejects when the document isn't focused
    return;
  }
  if (RETRYABLE.has(cell.state) && cell.matchId) {
    retrying.set(cell.matchId, state.matches[cell.matchId]?.lastAttemptAt);
    renderBoard();
    chrome.runtime.sendMessage({ type: "retry", matchId: cell.matchId }).catch(() => {
      retrying.delete(cell.matchId);
      renderBoard();
    });
  }
});

// ---------------------------------------------------------------- add, remove

const ADD_ERRORS = {
  [ErrorKind.NOT_FOUND]: (nick) => `no faceit player "${nick}"`,
  [ErrorKind.CHALLENGE]: () => "faceit.com is challenging requests, try again in a minute",
  [ErrorKind.RATE_LIMITED]: () => "rate limited by faceit.com, try again shortly",
  [ErrorKind.NETWORK]: () => "offline",
  board_full: () => `the board is full (${MAX_PLAYERS} players)`,
};

let addMsgTimer = null;
function say(text, { error = false } = {}) {
  clearTimeout(addMsgTimer);
  addMsg.textContent = text;
  addMsg.classList.toggle("error", error);
  if (text) addMsgTimer = setTimeout(() => say(""), ADD_MESSAGE_MS);
}

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const nickname = addInput.value.trim();
  if (!nickname) return;
  addInput.disabled = true;
  say("looking up…");
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "add", nickname });
  } catch {
    res = { ok: false, error: "worker" };
  }
  addInput.disabled = false;
  addInput.focus();

  if (!res?.ok) {
    say((ADD_ERRORS[res?.error] ?? (() => "lookup failed, try again"))(nickname), { error: true });
    addInput.select(); // keep it for fixing a typo, but typing anew replaces it
    return;
  }
  addInput.value = "";
  const p = res.profile;
  // Say exactly which account it was: FACEIT has distinct players differing only by case.
  if (!res.added) say(`${p.nickname} is already on the board`);
  else say(`+ ${p.nickname} · lvl ${p.level ?? "?"} · ${p.elo ?? "?"} elo`);
});

addInput.addEventListener("input", () => say(""));

async function removePlayer(id, nickname) {
  const res = await chrome.runtime.sendMessage({ type: "remove", id }).catch(() => null);
  if (res?.ok) say(`- ${nickname}`);
  else say(`couldn't remove ${nickname}`, { error: true });
}

// ---------------------------------------------------------------------- state

/* Every change, and the first load, re-reads the keys from storage rather than applying
 * `newValue`: a read always returns the latest value, so a change that lands between the
 * listener being added and the first read can't be lost or applied out of order. Reads
 * are batched per animation frame. */
const dirty = { sync: new Set(), local: new Set() };
let reloadScheduled = false;
let reloading = Promise.resolve(); // reloads run one after another, so reads land in order

function markDirty(area, keys) {
  for (const k of keys) if (FIELDS[area]?.[k]) dirty[area].add(k);
  if (!reloadScheduled && (dirty.sync.size || dirty.local.size)) {
    reloadScheduled = true;
    requestAnimationFrame(() => {
      reloadScheduled = false;
      reloading = reloading.then(reload, reload);
    });
  }
}

async function reload() {
  let board = false;
  for (const area of ["sync", "local"]) {
    const keys = [...dirty[area]];
    dirty[area].clear();
    if (!keys.length) continue;
    const got = await chrome.storage[area].get(keys);
    for (const key of keys) {
      const spec = FIELDS[area][key];
      state[spec.field] = got[key] ?? spec.empty();
      board ||= spec.board;
    }
  }
  if (board) renderBoard();
  renderStatus();
}

chrome.storage.onChanged.addListener((changes, area) => markDirty(area, Object.keys(changes)));
markDirty("sync", Object.keys(FIELDS.sync));
markDirty("local", Object.keys(FIELDS.local));

setInterval(renderStatus, 30_000); // keeps "synced 3m ago" honest

chrome.runtime.sendMessage({ type: "refresh" }).catch(() => {
  statusEl.textContent = "background worker unavailable";
  statusEl.classList.add("trouble");
});
