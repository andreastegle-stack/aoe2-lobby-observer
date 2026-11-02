# AoE2 Lobby Observer

A live list of open lobbies in Age of Empires II: Definitive Edition, built as a successor to
aoe2lobby.com/lobby. Data comes straight from the official game servers: no login, no API key.

Runs for free on Cloudflare Pages. The page lives in `public/`, and a small Cloudflare
function in `functions/` fetches and decodes the lobby data.

## Features

- Live lobby list, refreshed every 5 seconds (paused while the tab is in the background)
- Average lobby Elo (1v1 / team, Random Map / Empire Wars), search, sorting and filters
- Click a lobby to see players, civilizations, teams and settings; hover a player for ratings
- One-click **Join** / **Watch** (opens the game), copy the lobby's `aoe2de://0/<id>` link, hide lobbies

## Running it locally

Requires Node.js 20.10 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:8788. `npm run dev` runs the site in Cloudflare's own runtime.
`npm run local` runs a plain Node server on http://localhost:3000 instead (no install needed).

## How it works

| Part | File | What it does |
| --- | --- | --- |
| Lobby service | `lib/service.js` | Fetches the lobby list (at most every 5 s), adds player ratings (cached 15 min), keeps "first seen" times. Used by both Cloudflare and the local server. |
| Decoder | `lib/decode.js` | Unpacks each lobby's compressed settings and player slots (map, mode, size, civ, team). |
| Map names | `data/maps.json` | Map string id → name, extracted from the game's own string files. |
| Cloudflare | `functions/` | `/api/lobbies`, plus `/j/<id>` and `/w/<id>` redirects that open the game. |
| Web page | `public/` | Table with search, filters, sorting and expandable lobby details. |

Data sources (official AoE2 DE API, `aoe-api.worldsedgelink.com`):

- `community/advertisement/findAdvertisements?title=age2`: all open lobbies
- `community/leaderboard/GetPersonalStat?title=age2&profile_ids=[...]`: ratings

## Updating map names after a game patch

New maps from a DLC or patch show as "Map 12345" until the list is updated. On a machine
with the game installed through Steam:

```bash
npm run maps
```

If the game is installed elsewhere: `node scripts/extract-maps.js "<path to key-value-strings-utf8.txt>"`.

## Known limitations

- **Created** is when the server first saw the lobby. The API has no creation time, so it
  resets when the Cloudflare instance restarts.
- **Elo "–"** means nobody in the lobby has played ranked; the API has no rating for them.
- **Random civilizations**: variants (Full Random, Mirror, …) are all shown as "Random".

## Contributing

Pull requests are welcome. Keep the project dependency-free at runtime, and test your
change with `npm run dev` before opening a PR.

## License

MIT. Age of Empires II is a trademark of Microsoft; this fan project is not affiliated with
Microsoft or World's Edge.
