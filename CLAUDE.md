# Flight Tracker

Runs locally on this Mac under launchd (see README). No cloud deployment.

## After every change

1. Commit to git and push: `git push origin main`
2. Restart what changed: `launchctl kickstart -k gui/$(id -u)/com.flighttracker.server` (server/ or public/ changes need no restart for static files, but server code does) or `...fetcher` for fetcher/ changes.

Secrets live in `.env` (gitignored). Never commit `.env`, `data/` or `backup/`.
