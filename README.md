# Space Battle

Pilot your rocket, destroy enemies, and climb the leaderboard. Scores persist in **localStorage** by default, or sync globally via **Supabase** when configured.

## Features

- Canvas gameplay with WASD / arrow-key movement and click-to-shoot
- On-screen and modal leaderboards (top 6 scores)
- Optional cloud leaderboard with Supabase (realtime updates and cross-device sync)
- Graceful fallback to local storage when Supabase is not configured

## Tech stack

| Layer    | Stack                                      |
| -------- | ------------------------------------------ |
| Frontend | HTML, CSS, vanilla JavaScript, Canvas API  |
| Backend  | Supabase (PostgreSQL + Row Level Security) |
| Icons    | [Font Awesome](https://fontawesome.com/)   |

## Prerequisites

- A modern web browser
- (Optional) [Supabase](https://supabase.com/) project for shared leaderboards
- (Optional) A local static file server — required for Supabase config to load reliably (see [Run locally](#run-locally))

## Quick start

1. Clone or download this repository.
2. Serve the project from the **repository root** (see [Run locally](#run-locally)).
3. Open the app in your browser (e.g. `http://localhost:8000/frontend/`).
4. Click **Start Game** and play.

Without Supabase, scores are stored only in the browser’s localStorage.

## Run locally

`frontend/index.html` loads `../backend/config.js`. Opening the HTML file directly (`file://`) often blocks that script. Serve from the repo root instead:

```bash
# Python 3
python3 -m http.server 8000

# Node (npx, no install)
npx --yes serve -p 8000
```

Then visit: **http://localhost:8000/frontend/**

## Supabase setup (optional)

1. Create a project at [supabase.com](https://supabase.com/).
2. In the Supabase dashboard, open **Settings → API** and copy:
   - **Project URL**
   - **anon public** key
3. Edit `backend/config.js`:

   ```js
   const SUPABASE_CONFIG = {
       url: 'https://YOUR_PROJECT.supabase.co',
       anonKey: 'YOUR_ANON_KEY_HERE'
   };
   ```

4. In **SQL Editor**, run the contents of `backend/schema.sql` to create the `scores` table and RLS policies (public read/insert for the leaderboard).

5. Reload the game. The browser console should no longer show the local-fallback message.

> **Security note:** The anon key is intended for client-side use. Restrict what clients can do via Row Level Security policies (as in `schema.sql`). Do not commit production secrets you are not comfortable exposing; use environment-specific keys for deployed apps.

## How to play

| Action   | Input                          |
| -------- | ------------------------------ |
| Move     | `W` `A` `S` `D` or arrow keys  |
| Shoot    | Click on the game canvas       |
| Goal     | Survive, score points, avoid hits |

After **Game Over**, enter a name to **Record Score** (if you qualify for the top 6) or **Restart**.

## Project structure

```
space-battle/
├── frontend/
│   ├── index.html    # Game shell and UI
│   ├── script.js     # Game logic and leaderboard
│   └── style.css     # Layout and styling
├── backend/
│   ├── config.js     # Supabase URL and anon key
│   └── schema.sql    # Leaderboard table and RLS policies
└── README.md
```

## Development notes

- Game loop and entities live in `frontend/script.js`; UI toggles and modals are in `frontend/index.html`.
- Leaderboard logic uses Supabase when `anonKey` is set and not the placeholder `YOUR_ANON_KEY_HERE`; otherwise it uses `localStorage` and `BroadcastChannel` for same-origin tab sync.
- Font Awesome is loaded from the Font Awesome Kit CDN in `index.html`.
