# FACEIT Crosshair Board

A Chrome extension that replaces the new tab page with a grid of CS2 crosshairs: one row
per FACEIT player you pick, one column per match of their last 10, newest on the left.
Click a cell to copy that crosshair's share code.

- A cell with an orange corner is a crosshair that changed since the player's match
  before; unchanged ones are dimmed, so changes stand out at a glance.
- Hover a cell for the map, score, date and share code.
- Add a player with `> add:` and Enter (nickname, case-insensitive); remove with `[x]` on
  the row.

## How it gets the data

There is no API key and no server of its own. Everything comes from faceit.com's own web
API, the same requests the FACEIT site makes:

| What | Endpoint |
|---|---|
| Nickname / profile | `/api/users/v1/nicknames/{nick}`, `/api/users/v1/users/{id}` |
| Case-insensitive search (fallback) | `/api/searcher/v1/players` |
| Last 10 matches | `/api/stats/v1/stats/time/users/{id}/games/cs2` |
| Crosshairs of all 10 players in a match | `/api/statistics/v1/cs2/matches/{id}/match-rounds/1/scoreboard-summary` |

The extension is built to stay far below FACEIT's limits:

- A crosshair that was fetched once is never fetched again. A refresh is one cheap history
  request per player, and only matches that are new since then cost a scoreboard request.
  One request covers everyone in that match, so shared matches are fetched once.
- Requests go through one queue in the background worker, one at a time, paced from the
  rate-limit headers FACEIT sends. A new tab never waits on the network: it renders from
  the cache and only asks for players whose data is over 15 minutes old.
- Rate limits, Cloudflare challenges and network errors back off exponentially (up to 15
  minutes) and show up in the status line instead of retrying in a loop.

Some matches FACEIT shows only to logged-in users; their cells say `login`. Requests carry
your faceit.com cookies, so once you are logged in on faceit.com in the same browser they
come through: click such a cell to retry it at once (it is also re-checked every 6 hours).
A match FACEIT keeps failing on shows `error` and is retried a few times, then left alone.

## Privacy

No analytics, no tracking, no data leaves your browser except the requests to
www.faceit.com listed above. Your player list is kept in `chrome.storage.sync` (so it
follows your Chrome profile); the cache of profiles, histories and crosshairs in
`chrome.storage.local`.

Permissions: `storage` for the above, `alarms` to refresh in the background a couple of
players every 30 minutes, and host access to `https://www.faceit.com/*` for the API.

## Development

No build step and no dependencies. `src/` is the extension as shipped.

- Run: `chrome://extensions` -> Developer mode -> Load unpacked -> `src/`.
- Test: `node --test` (Node 22 or newer).
- See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, releasing, and the list of
  things that look wrong but aren't.

Sibling project: [FACEIT Crosshair Peek](https://github.com/lednifrolg/faceit-crosshair-peek),
which previews crosshairs when hovering a match on FACEIT itself.

## Licence

GPL-3.0-or-later, see [LICENSE](LICENSE) and [THIRD-PARTY.md](THIRD-PARTY.md).
