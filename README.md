# Flight Price Tracker

Tracks flight prices on a schedule and sends Telegram alerts when prices drop or hit a new all-time low. Runs entirely on one Mac, served privately over Tailscale. No cloud account needed.

## What it does

- Add flights to track: origin(s), destination, dates, passengers, stop/time/duration filters, alert threshold
- Checks prices at 6am, 12pm and 6pm ET from two sources in parallel and uses the lowest as the trigger
- Telegram alert on a new all-time best or a drop of at least your threshold, with all source prices side by side
- Z-score trend indicator against the last 20 checks, and a price-history chart per flight
- "Get Live Price" and "Test Telegram" buttons per flight

## Price sources

| Source | Notes |
|--------|-------|
| **Google Flights** (`fast_flights` scraper) | Primary source; scrapes Google Flights HTML. |
| **fli Scanner** (`pip install flights`) | Google's private API. As of Oct 2026 it returns no results (upstream change); it is kept and will pick up again if the library is fixed. |

## Architecture

```
launchd (KeepAlive)
├─ com.flighttracker.server   Node 22 + Express, port 4330
│    ├─ serves public/ (the UI)
│    ├─ REST API  /api/flights ...
│    ├─ SQLite    data/flights.db
│    └─ node-cron 0 6,12,18 * * *  America/New_York  → price check + Telegram
└─ com.flighttracker.fetcher  Flask/gunicorn, 127.0.0.1:4331
     ├─ POST /price      Google Flights
     └─ POST /fli-price  fli Scanner
```

Access control follows the Bedside dashboard: the server binds `0.0.0.0` but rejects every request that is not loopback or in Tailscale's `100.64.0.0/10` range, so only your own Tailscale devices can reach it. Open `http://<mac-tailscale-name-or-ip>:4330` from any device on the tailnet.

If the Mac was asleep or off during a scheduled slot, the server runs one catch-up check ~30s after it starts when the last run is over 8 hours old.

## Setup

```bash
# 1. Config
cp .env.example .env        # fill in TELEGRAM_TOKEN

# 2. Node server
cd server && npm install && cd ..

# 3. Python fetcher
/opt/homebrew/bin/python3.12 -m venv fetcher/.venv
fetcher/.venv/bin/pip install -r fetcher/requirements.txt

# 4. launchd services (auto-start at login, auto-restart on crash)
mkdir -p ~/Library/Logs/flighttracker
cp deploy/*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flighttracker.fetcher.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flighttracker.server.plist
```

The plists contain absolute paths for this machine (`/Users/staciedee/Projects/flighttracker`); edit them if you move the project.

## Operating it

```bash
launchctl kickstart -k gui/$(id -u)/com.flighttracker.server    # restart server
launchctl kickstart -k gui/$(id -u)/com.flighttracker.fetcher   # restart fetcher
tail -f ~/Library/Logs/flighttracker/server.log
curl localhost:4330/api/health
curl -X POST localhost:4330/api/check-now                       # run the full check now
```

Logs: `~/Library/Logs/flighttracker/`. Data: `data/flights.db` (SQLite, gitignored; back up by copying it, ideally while the server is stopped or with `sqlite3 data/flights.db ".backup out.db"`).

## History

Originally a Firebase app (Cloud Functions, Firestore, Cloud Run, Hosting). Migrated to local hosting in Oct 2026; the Firestore data was imported with `server/import-firestore.js` and the GCP project was deleted.
