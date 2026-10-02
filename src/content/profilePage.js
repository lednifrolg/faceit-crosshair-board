/* FACEIT Crosshair Board - profile page logic for the "add to board" button
 *
 * The pure half of the content script: which page is a profile and whose, whether that
 * player is on the board, and what the button says in each state. No DOM, no chrome.*,
 * so `node --test` can load it (see tests/profilePage.test.js).
 *
 * Content scripts are classic scripts sharing one isolated-world global scope, so this
 * file exposes its API as `globalThis.FcbProfilePage` instead of using `export`, like
 * lib/pixelCrosshair.js. The manifest must list it before profileButton.js.
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

  /* Any page under a player's profile, capturing the nickname: the overview
   * (/en/players/donk666), its subpages (/cs2/history, /stats, ...) and the profile modal
   * FACEIT opens over other pages (/players-modal/...). One regex answers both "is this a
   * profile" and "whose", the same as Crosshair Peek's PROFILE_PATH; the trailing
   * (?:\/|$) is what admits the overview alongside its subpages. */
  const PROFILE_PATH = /\/players(?:-modal)?\/([^/]+)(?:\/|$)/;

  /** The profile's nickname, exact case as in the URL, or null off a profile. */
  function profileNickname(pathname) {
    const m = PROFILE_PATH.exec(pathname ?? "");
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]) || null;
    } catch {
      return null; // a malformed %-escape is not a nickname FACEIT could have issued
    }
  }

  /**
   * The board entry (`{ id, nickname }`) for this profile, or null.
   *
   * By id once the profile's id is known: `players` keeps nicknames only as fresh as the
   * worker's daily profile check, so after a rename the stored nickname is stale, and a
   * freed nickname can even belong to someone else by now. Until the id is known (or if
   * looking it up failed), fall back to the nickname, compared case-sensitively because
   * FACEIT has distinct accounts that differ only by case (`scream` vs `ScreaM`).
   */
  function findPlayer(players, { id = null, nickname = null } = {}) {
    if (!Array.isArray(players)) return null;
    const hit = id != null
      ? players.find((p) => p?.id === id)
      : nickname != null ? players.find((p) => p?.nickname === nickname) : undefined;
    return hit ?? null;
  }

  /** What each failed `add`/`remove` shows on the button, keyed by lib/api.js ErrorKind. */
  const ERROR_TEXT = Object.freeze({
    not_found: "PLAYER NOT FOUND",
    challenge: "FACEIT BUSY, RETRY",
    rate_limited: "RATE LIMITED, RETRY",
    network: "OFFLINE, RETRY",
    board_full: "BOARD FULL",
    invalidated: "RELOAD PAGE", // the extension was updated or reloaded under this tab
  });
  const DEFAULT_ERROR = "FAILED, RETRY";

  const errorText = (kind) => ERROR_TEXT[kind] ?? DEFAULT_ERROR;

  /** Button states. `onBoard` and `hover` only matter for IDLE. */
  const Phase = Object.freeze({ IDLE: "idle", ADDING: "adding", REMOVING: "removing", ERROR: "error" });

  /**
   * The button's look as data: `mark` goes inside the brackets, `tone` picks the colour
   * (`add` green on black, `on` solid green, `remove` orange, `busy`, `error`).
   * Hovering ON BOARD previews the click, like a "following / unfollow" button.
   */
  function buttonView({ phase = Phase.IDLE, onBoard = false, hover = false, error = null } = {}) {
    switch (phase) {
      case Phase.ADDING:
        return { mark: "_", text: "ADDING", tone: "busy", busy: true };
      case Phase.REMOVING:
        return { mark: "_", text: "REMOVING", tone: "busy", busy: true };
      case Phase.ERROR:
        return { mark: "!", text: errorText(error), tone: "error", busy: false };
      default:
        if (!onBoard) return { mark: "+", text: "ADD TO BOARD", tone: "add", busy: false };
        if (hover) return { mark: "x", text: "REMOVE", tone: "remove", busy: false };
        return { mark: "✓", text: "ON BOARD", tone: "on", busy: false };
    }
  }

  globalThis.FcbProfilePage = Object.freeze({
    PROFILE_PATH, Phase, ERROR_TEXT, profileNickname, findPlayer, errorText, buttonView,
  });
})();
