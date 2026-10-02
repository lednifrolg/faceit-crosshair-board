# Contributing

There is no build step and no package.json. `src/` **is** the extension; the pure logic in
`src/lib/` is tested with `node --test` (Node 22 or newer, no dependencies).

## Layout

| File | Role |
|---|---|
| `src/background.js` | Service worker. Only wires chrome events to `lib/worker.js`. |
| `src/lib/worker.js` | Refresh policy and the queue runner. Owns all network traffic. |
| `src/lib/queue.js` | Pure queue state transitions: ordering, pacing, backoff. |
| `src/lib/store.js` | Data model, fetch policy, board view model, serialised storage writes. |
| `src/lib/api.js` | FACEIT endpoints, response parsing, error kinds. |
| `src/newtab.*`, `src/crosshair.js` | The board. Renders from storage only, never fetches. |
| `src/lib/crosshairRenderer.js`, `src/lib/pixelCrosshair.js` | Share code decoding and drawing, copied from Crosshair Peek. |
| `icons/make.py` | Regenerates `src/icons/*.png` (needs `rsvg-convert`). |

## Running it locally

1. `chrome://extensions` -> **Developer mode** -> **Load unpacked** -> select `src/`.
2. After editing, hit the reload icon on the extension card, then open a new tab. The
   worker keeps its queue in storage, so a reload resumes where it stopped. Restarting
   the browser is not enough: Chrome keeps the registered service worker of an unpacked
   extension across restarts while the version is unchanged, so the new tab page would
   run new code against the old worker.
3. The service worker's own DevTools (the "service worker" link on the card) has the
   Network panel that shows every request the extension makes.

## Testing a change

- `node --test` covers the API parsing, the data model and the whole refresh flow against
  a fake FACEIT and a fake clock (`tests/worker.test.js`).
- By hand: add and remove a player, check a match with no advanced stats, and watch the
  worker's Network panel: a refresh after one new match must send exactly one
  scoreboard request.
- Look at the board at a narrow window width too; the grid scrolls sideways under a
  sticky name column.

## Releasing

1. Bump `version` in `src/manifest.json`.
2. Commit, then tag and push `vX.Y.Z`.

`.github/workflows/release.yml` runs the tests, checks the tag matches the manifest, and
attaches `faceit-crosshair-board-vX.Y.Z.zip` (`src/` plus `LICENSE`, `THIRD-PARTY.md`,
`README.md`) to a GitHub release. That zip is what goes to the Chrome Web Store.

## Things that look wrong but aren't

- **`credentials: "include"`** on every request. It carries faceit.com's Cloudflare
  cookie and, for a logged-in user, the session that unlocks `err_f0` matches. `omit`
  was tested and is no better against Cloudflare.
- **`cache: "no-store"`**. A cached 200 carries no rate-limit headers, which would blind
  the pacing.
- **A Cloudflare challenge is retried, not fatal.** They come in short bursts, mostly on a
  cold browser profile, and the next request usually passes. Only three in a row turn
  the status into "blocked", and even then the queue keeps retrying slowly.
- **`pick()` in `api.js` reads two key casings** (`playerId`/`player_id`). The scoreboard
  endpoint genuinely returns both.
- **`parseShareCode()` compares by identity** with the renderer's `defaultSettings`. The
  vendored parser returns that object on failure, and it renders as a plausible crosshair.
  Don't turn it into a deep equality check.
- **Map, date and score live in each player's history, not in `matches`.** The score is
  from that player's side, so opponents in a shared match need different values.
- **Nickname lookup is case sensitive and that's kept.** FACEIT has distinct accounts that
  differ only by case (`scream` vs `ScreaM`), so the exact match wins and search is only
  the fallback.
- **Tests live in `tests/`, not `test/`.** `node --test` runs every file under a `test/`
  directory, helpers included.
- **The latest column is never dimmed**, even when unchanged: it is the crosshair the
  player uses now.
- **"Changed" compares decoded crosshairs, not share codes** (`crosshairKey` in
  `src/crosshair.js`). CS2 switched code formats on 2026-09-30, so most players have a new
  code for an unchanged crosshair.
- **The new tab re-reads storage on every change instead of using `newValue`**, and
  patches the grid instead of rebuilding it. The first keeps a change that lands during
  startup from being lost; the second keeps focus, hover and clicks intact while the
  queue writes every few seconds.
- **The status line is derived from the queue (`conditionOf`), never stored**, so a
  "challenged, retrying" can't outlive the queue that was retrying.

New source files need the SPDX `GPL-3.0-or-later` header used in `src/background.js`.
DOM is built with `document.createElement`, never `innerHTML`.
