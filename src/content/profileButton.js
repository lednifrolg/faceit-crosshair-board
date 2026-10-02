/* FACEIT Crosshair Board - "add to board" button on FACEIT player profiles
 *
 * A small fixed button in a corner of every player profile: `[+] ADD TO BOARD`, or
 * `[✓] ON BOARD` when the player is already on the new tab board. Clicking toggles it.
 *
 * Adding and removing go through the service worker (`add` / `remove` messages), the same
 * path the new tab page uses, so the profile cache and the fetch queue stay consistent and
 * the worker's exact-then-search nickname resolution is shared. The on-board state is read
 * from storage.sync `players` and follows storage changes, so a player added or removed in
 * a new tab flips the button here too.
 *
 * The pure parts (path matching, on-board matching, labels) are in profilePage.js.
 *
 * Copyright (C) 2026 Filip Tomasovych
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version. See the LICENSE file for details.
 */
(() => {
  "use strict";

  const { Phase, profileNickname, findPlayer, buttonView } = globalThis.FcbProfilePage;

  const PLAYERS_KEY = "players"; // lib/store.js SyncKey.PLAYERS; modules can't be imported here
  const ERROR_MS = 4000;
  const FONT_FAMILY = "FCB JetBrains Mono"; // own name, so it can't collide with the page's

  // -------------------------------------------------------------- player id
  //
  // The board is matched by player id (see findPlayer), and the URL only has the
  // nickname. The page's own origin can read FACEIT's nickname endpoint, which is cheap
  // (600/s bucket, not behind the Cloudflare challenge) and is what Crosshair Peek uses
  // for the same purpose. Cached per nickname, so SPA navigation needs no invalidation.
  //
  // Resolves to the id, to MISSING when FACEIT has no account with exactly this nickname,
  // or to null when the lookup failed (then on-board matching falls back to the nickname).
  // MISSING hides the button: FACEIT redirects such URLs (wrong case included) to
  // /en/notfound, and a click in that moment would let the worker's case-insensitive
  // search fallback add a different account.

  const MISSING = false;
  const ids = new Map(); // nickname -> Promise<id | MISSING | null>

  function lookupId(nickname) {
    if (!ids.has(nickname)) {
      const p = fetch(`/api/users/v1/nicknames/${encodeURIComponent(nickname)}`, { credentials: "omit" })
        .then((res) => (res.status === 404 ? MISSING : res.ok ? res.json().then((j) => j?.payload?.id ?? null) : null))
        .catch(() => null)
        .then((id) => {
          if (id == null) ids.delete(nickname); // retry next time rather than cache a failure
          return id;
        });
      ids.set(nickname, p);
    }
    return ids.get(nickname);
  }

  // ------------------------------------------------------------------ state

  const state = {
    nickname: null,   // profile shown, exact case from the URL; null when detached
    id: null,         // its player id, once looked up
    missing: false,   // no such account (see lookupId)
    idPromise: null,
    players: [],      // storage.sync `players`
    loaded: false,    // `players` has been read; nothing renders before, to never show a wrong state
    phase: Phase.IDLE,
    error: null,
    hover: false,
    // After a click flips the state, the pointer is still on the button; previewing the
    // opposite action right away ("REMOVE" just after adding) reads like the add failed.
    // So the hover preview waits until the pointer has left once.
    hoverArmed: true,
  };

  const contextAlive = () => Boolean(globalThis.chrome?.runtime?.id);

  // -------------------------------------------------------------------- DOM

  let root = null;
  let button = null;
  let markEl = null;
  let textEl = null;
  let errorTimer = null;
  let font = null;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  function build() {
    root = el("div", "fcb-root");
    button = el("button", "fcb-btn");
    button.type = "button";
    markEl = el("span", "fcb-mark");
    textEl = el("span", "fcb-text");
    button.append(el("span", "fcb-bracket", "["), markEl, el("span", "fcb-bracket", "]"), textEl);
    root.append(button);
    button.addEventListener("click", onClick);
    button.addEventListener("pointerenter", onEnter);
    button.addEventListener("pointerleave", onLeave);
  }

  /* The bundled font, so the button matches the new tab page. Added through the FontFace
   * API rather than an @font-face rule in profileButton.css because the font's URL is only
   * known at runtime (the extension id, or a per-session id with use_dynamic_url). A
   * failed load just leaves the monospace fallback in place. */
  function loadFont() {
    if (!font) {
      try {
        const url = chrome.runtime.getURL("fonts/JetBrainsMono-Bold.woff2");
        font = new FontFace(FONT_FAMILY, `url("${url}") format("woff2")`, { weight: "700", display: "swap" });
        font.load().catch(() => {});
      } catch {
        return;
      }
    }
    document.fonts.add(font);
  }

  function render() {
    if (!root || state.nickname == null || !state.loaded) return;
    if (state.missing) {
      root.remove();
      return;
    }
    const onBoard = findPlayer(state.players, state) != null;
    const view = buttonView({
      phase: state.phase,
      onBoard,
      hover: state.hover && state.hoverArmed,
      error: state.error,
    });
    markEl.textContent = view.mark;
    textEl.textContent = view.text;
    button.className = `fcb-btn fcb-tone-${view.tone}`;
    button.setAttribute("aria-pressed", String(onBoard));
    button.setAttribute("aria-busy", String(view.busy));
    button.title = onBoard
      ? `${state.nickname} is on your FACEIT Crosshair Board. Click to remove.`
      : `Add ${state.nickname} to your FACEIT Crosshair Board (new tab page).`;
    // FACEIT re-renders its own tree, not body, but don't depend on that.
    if (!root.isConnected) document.body.append(root);
  }

  // ----------------------------------------------------------------- events

  function onEnter() {
    state.hover = true;
    render();
  }

  function onLeave() {
    state.hover = false;
    state.hoverArmed = true;
    render();
  }

  function showError(kind) {
    clearTimeout(errorTimer);
    state.phase = Phase.ERROR;
    state.error = kind;
    render();
    if (kind === "invalidated") return; // stays: nothing here can work until a reload
    errorTimer = setTimeout(() => {
      state.phase = Phase.IDLE;
      state.error = null;
      render();
    }, ERROR_MS);
  }

  async function send(msg) {
    if (!contextAlive()) return { ok: false, error: "invalidated" };
    try {
      return (await chrome.runtime.sendMessage(msg)) ?? { ok: false, error: "worker" };
    } catch {
      return { ok: false, error: contextAlive() ? "worker" : "invalidated" };
    }
  }

  async function onClick() {
    if (state.phase === Phase.ADDING || state.phase === Phase.REMOVING) return;
    if (state.phase === Phase.ERROR && state.error === "invalidated") return;
    clearTimeout(errorTimer);
    const nickname = state.nickname;

    // Decide by id, so a stale or recycled nickname on the board can't make this remove
    // the wrong player. The lookup normally finished long before anyone clicks.
    const entry0 = findPlayer(state.players, state);
    state.phase = entry0 ? Phase.REMOVING : Phase.ADDING;
    render();
    await state.idPromise;
    if (state.nickname !== nickname) return; // navigated away meanwhile; detach reset us
    if (state.missing) {
      state.phase = Phase.IDLE;
      return render(); // hides the button
    }
    const entry = findPlayer(state.players, state);

    let res;
    if (entry) {
      state.phase = Phase.REMOVING;
      render();
      res = await send({ type: "remove", id: entry.id });
      if (res?.ok) state.players = state.players.filter((p) => p.id !== entry.id);
    } else {
      state.phase = Phase.ADDING;
      render();
      res = await send({ type: "add", nickname });
      const p = res?.profile;
      if (res?.ok && p?.id) {
        if (state.nickname === nickname && state.id == null) state.id = p.id;
        if (!state.players.some((x) => x.id === p.id)) {
          state.players = [...state.players, { id: p.id, nickname: p.nickname }];
        }
      }
    }
    // storage.onChanged brings the authoritative `players` too; the local update above
    // only keeps the label from flicking back while that event is in flight.
    if (state.nickname !== nickname) return;
    if (!res?.ok) return showError(res?.error);
    state.phase = Phase.IDLE;
    state.hoverArmed = false;
    render();
  }

  function onStorageChanged(changes) {
    const change = changes[PLAYERS_KEY];
    if (!change) return;
    state.players = Array.isArray(change.newValue) ? change.newValue : [];
    render();
  }

  // ------------------------------------------------------------- activation
  //
  // The manifest matches all of www.faceit.com because FACEIT is an SPA: a narrower match
  // would never inject when a profile is reached by clicking through. Off a profile the
  // only thing alive is the single `navigate` listener at the bottom: no DOM, no storage
  // listener, no requests. Everything else is created in attach() and torn down in
  // detach(), and attach() also handles moving from one profile straight to another.

  function attach(nickname) {
    if (state.nickname === nickname) return;
    const first = state.nickname == null;
    state.nickname = nickname;
    state.id = null;
    state.phase = Phase.IDLE;
    state.error = null;
    state.hoverArmed = true;
    clearTimeout(errorTimer);

    state.missing = false;
    const promise = lookupId(nickname).then((id) => {
      if (state.idPromise === promise && id != null) {
        if (id === MISSING) state.missing = true;
        else state.id = id;
        render();
      }
      return id;
    });
    state.idPromise = promise;

    if (first) {
      chrome.storage.sync.onChanged.addListener(onStorageChanged);
      chrome.storage.sync
        .get(PLAYERS_KEY)
        .then((got) => {
          if (state.nickname == null) return;
          state.players = Array.isArray(got[PLAYERS_KEY]) ? got[PLAYERS_KEY] : [];
          state.loaded = true;
          render();
        })
        .catch(() => {});
      if (!root) build();
      loadFont();
    }
    render();
  }

  function detach() {
    if (state.nickname == null) return;
    state.nickname = null;
    state.id = null;
    state.missing = false;
    state.idPromise = null;
    state.players = [];
    state.loaded = false;
    state.phase = Phase.IDLE;
    state.error = null;
    state.hover = false;
    clearTimeout(errorTimer);
    try {
      chrome.storage.sync.onChanged.removeListener(onStorageChanged);
    } catch {
      // the extension context is gone; so is the listener
    }
    root?.remove();
    if (font) document.fonts.delete(font);
  }

  function syncFor(path) {
    if (!contextAlive()) {
      // The extension was reloaded or updated under this tab. Nothing chrome.* works any
      // more, and the new version doesn't inject into already open tabs, so step aside.
      detach();
      if (typeof navigation !== "undefined") {
        navigation.removeEventListener("navigate", onNavigate);
        navigation.removeEventListener("navigatesuccess", onSettled);
        navigation.removeEventListener("navigateerror", onSettled);
      }
      return;
    }
    const nickname = profileNickname(path);
    if (nickname) attach(nickname);
    else detach();
  }

  function onNavigate(e) {
    // `navigate` fires before location updates, so read the destination.
    let path = location.pathname;
    try {
      path = new URL(e.destination.url).pathname;
    } catch {
      // keep the current path rather than throw out of the listener and strand the gate
    }
    syncFor(path);
  }

  // A cancelled or failed navigation can leave the gate ahead of the URL; this settles it.
  const onSettled = () => syncFor(location.pathname);

  if (typeof navigation !== "undefined") {
    navigation.addEventListener("navigate", onNavigate);
    navigation.addEventListener("navigatesuccess", onSettled);
    navigation.addEventListener("navigateerror", onSettled);
  }
  // Without the Navigation API (it exists since Chrome 102, the manifest requires 120)
  // the button would only follow full page loads.
  syncFor(location.pathname);
})();
