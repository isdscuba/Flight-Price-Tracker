# Flight Price Tracker

Tracks flight prices on a schedule and sends Telegram alerts when prices drop or hit a new all-time low. Runs entirely on one Mac, served privately over Tailscale. No cloud account needed.

## What it does

- Add flights to track: origin(s), destination, dates, passengers, stop/time/duration filters, alert threshold
- Checks prices at 6am, 12pm and 6pm ET from two sources in parallel and uses the lowest as the trigger
- Telegram alert on a new all-time best or a drop of at least your threshold, with all source prices side by side
- Z-score trend indicator against the last 20 checks, and a price-history chart per flight
- "Get Live Price" and "Test Telegram" buttons per flight

## Price sources

Every check queries these in parallel/sequence (spaced out; see Pacing) and the **lowest price wins**. Telegram shows each source's price and marks the winner.

| Source | Notes |
|--------|-------|
| **Google Flights** (`fast_flights` 2.2 scraper) | Main source. Applies stops, departure-window, duration and airline filters itself. |
| **Kiwi.com** (free public MCP at `mcp.kiwi.com`, no key) | Independent of Google. Filters are passed to Kiwi (stops, duration, departure window). Alerts include a Kiwi booking link when it wins. |
| **Google Flights (alt)** (`fast-flights` 3.x, separate service) | A second parser/request path for Google. **Only displayed when its price differs from the main Google price**; counts toward "best price" only then. |
| fli Scanner | Disabled (`ENABLE_FLI=1` to retry). Google currently rejects its requests (upstream issue). |

## Pacing

All price fetches (scheduled, retry, UI button) go through one gate: at least 15–20s between fetches, 8–15s extra between flights, 2s between airports, and retries back off 20s then 60s. A 20-tracker run takes roughly 10–15 minutes.

## Setup

```bash
# 1. Config
cp .env.example .env        # fill in TELEGRAM_TOKEN

# 2. Node server
cd server && npm install && cd ..

# 3. Python fetcher
/opt/homebrew/bin/python3.12 -m venv fetcher/.venv
fetcher/.venv/bin/pip install -r fetcher/requirements.txt
/opt/homebrew/bin/python3.12 -m venv fetcher3/.venv
fetcher3/.venv/bin/pip install -r fetcher3/requirements.txt   # separate venv: 3.x conflicts with 2.2

# 4. launchd services (auto-start at login, auto-restart on crash)
mkdir -p ~/Library/Logs/flighttracker
cp deploy/*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flighttracker.fetcher.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flighttracker.fetcher3.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flighttracker.server.plist
```

The plists contain absolute paths for this machine (`/Users/staciedee/Projects/flighttracker`); edit them if you move the project.

## Operating it

```bash
launchctl kickstart -k gui/$(id -u)/com.flighttracker.server    # restart server
launchctl kickstart -k gui/$(id -u)/com.flighttracker.fetcher   # restart fetcher (also: fetcher3)
tail -f ~/Library/Logs/flighttracker/server.log
curl localhost:4330/api/health
curl -X POST localhost:4330/api/check-now                       # run the full check now
```

Logs: `~/Library/Logs/flighttracker/`. Data: `data/flights.db` (SQLite, gitignored; back up by copying it, ideally while the server is stopped or with `sqlite3 data/flights.db ".backup out.db"`).

## History

Originally a Firebase app (Cloud Functions, Firestore, Cloud Run, Hosting). Migrated to local hosting in Oct 2026; the Firestore data was imported with `server/import-firestore.js` and the GCP project was deleted.
