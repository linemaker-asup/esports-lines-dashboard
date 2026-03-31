# Esports Lines Dashboard

Compare esports player prop lines across **PrizePicks** and **Underdog Fantasy** in a single dashboard. Supports Dota 2, CS2, League of Legends, Valorant, and Call of Duty.

## Architecture

The project has three components:

| Component | Path | Deployed To | Description |
|-----------|------|-------------|-------------|
| **Frontend** | `frontend/` | Vercel (Vite + React) | Dashboard UI that displays and compares lines |
| **API (Edge Function)** | `frontend/api/lines.js` | Vercel Edge | Fetches Underdog lines directly, PrizePicks via the Python proxy, normalizes stats, and matches lines across platforms |
| **PrizePicks Proxy** | `pp-python/` | Vercel (Python Serverless) | Bypasses PrizePicks' PerimeterX bot protection using `curl_cffi` TLS fingerprint impersonation |

### Data Flow

```
Browser  -->  /api/lines (Edge Function)  -->  Underdog Fantasy API (direct)
                                          -->  pp-python proxy  -->  PrizePicks API (via curl_cffi)
```

1. The frontend calls `/api/lines`
2. The edge function fetches lines from both platforms in parallel
3. Lines are normalized and matched by player name + stat type (including map range normalization)
4. The frontend displays matched and unmatched lines with diffs

## Features

- **Cross-platform matching** -- Normalizes player names and stat types (including map ranges like "Maps 1+2", "Maps 1+2+3") to match lines across PrizePicks and Underdog
- **Line diffs** -- Shows the difference between platforms, color-coded by magnitude
- **Game filtering** -- Filter by game (LOL, CS2, DOTA2, VAL, COD) or search by player/team/stat
- **Matched-only toggle** -- Show only lines that appear on both platforms
- **Flash sale indicators** -- Highlights PrizePicks flash sale lines and promo lines
- **Underdog odds** -- Displays higher/lower American odds from Underdog
- **Auto-refresh** -- Manual refresh button to pull latest lines
- **PrizePicks proxy** -- Handles PerimeterX protection with TLS impersonation and 5-minute server-side caching

## Setup

### Frontend + API

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server runs on `http://localhost:5173`. The `/api/lines` edge function is deployed alongside the frontend on Vercel.

### PrizePicks Proxy

The proxy is deployed as a separate Vercel project at `pp-python.vercel.app`.

```bash
cd pp-python
pip install -r requirements.txt
```

It uses `curl_cffi` with `edge101` TLS fingerprint impersonation to bypass PrizePicks' bot protection.

### Deployment

Both components deploy to Vercel:

- **Frontend + API**: Deploy `frontend/` as a Vite project. The `vercel.json` routes `/api/*` requests to the edge function in `frontend/api/lines.js`.
- **PrizePicks Proxy**: Deploy `pp-python/` as a separate Vercel project. The edge function references it at `https://pp-python.vercel.app/api/prizepicks`.

## CLI Export Tool

A standalone Python script (`export_lines.py`) can export lines to CSV without the dashboard:

```bash
# Export all lines
python export_lines.py

# Filter by game
python export_lines.py --game DOTA2

# Only matched lines
python export_lines.py --matched-only

# Custom output path
python export_lines.py --output my_lines.csv
```

Output CSV columns: `game`, `player`, `team`, `stat`, `match`, `scheduled`, `underdog_line`, `underdog_higher`, `underdog_lower`, `prizepicks_line`, `prizepicks_flash`, `prizepicks_promo`, `diff`, `matched`

## Stat Normalization

Lines are matched across platforms using normalized player names and stat types. Map ranges are normalized to handle different formats:

| Platform | Raw Stat | Normalized |
|----------|----------|------------|
| Underdog | "Kills on Maps 1+2" | `kills m12` |
| PrizePicks | "MAPS 1-2 Kills" | `kills m12` |
| Underdog | "Kills on Maps 1+2+3" | `kills m123` |
| PrizePicks | "MAPS 1-3 Kills" | `kills m123` |

The display shows these as "Map 1+2" and "Map 1+2+3" regardless of the source platform.

## Supported Games

| Code | Game |
|------|------|
| `LOL` | League of Legends |
| `CS2` | Counter-Strike 2 |
| `DOTA2` | Dota 2 |
| `VAL` | Valorant |
| `COD` | Call of Duty |

## Tech Stack

- **Frontend**: React 18 + TypeScript + Tailwind CSS + Vite
- **API**: Vercel Edge Functions (JavaScript)
- **Proxy**: Vercel Python Serverless Functions + curl_cffi
- **CLI**: Python 3 (stdlib only, no dependencies)
