# Flight Tracker — Setup & Redeployment Guide

Firebase and Telegram are already configured and working. This guide covers the one remaining
step: getting your **Travelpayouts** API token, putting it in the right place, and redeploying.

---

## What you need to do (overview)

1. Get your **Travelpayouts** API token
2. Update `functions/.env` with the token + your Telegram token
3. Run `firebase deploy --only functions`

That's it. Firebase, Firestore, and all frontend code are untouched.

---

## Step 1 — Travelpayouts API Token

> ⚠️ **The token is NOT in Programs → Tools → Links** (the affiliate section).
> It lives in your Profile / Developer settings.

1. Log in at **https://www.travelpayouts.com/**
2. Go to: **https://www.travelpayouts.com/profile/api**
   *(or click your profile icon → look for "API token" tab)*
3. Your token is a 32-character string like: `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4`
   Click **"Update token"** if the field is empty.
4. Copy it — you'll paste it into `.env` in the next step

> Travelpayouts returns cached prices updated multiple times a day via the Aviasales network.

---

## Step 2 — Update `functions/.env`

Open `flight-tracker/functions/.env`. It currently looks like:

```bash
TRAVELPAYOUTS_TOKEN=3110cc78ab7535b3fd4a899402ae75ec
TELEGRAM_TOKEN=your_telegram_bot_token_here
```

Your Travelpayouts token is already filled in. Just replace `your_telegram_bot_token_here`
with your actual Telegram bot token. Final result:

```bash
TRAVELPAYOUTS_TOKEN=3110cc78ab7535b3fd4a899402ae75ec
TELEGRAM_TOKEN=8306429770:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> **Do not commit this file to git.** It is already in `.gitignore`.

---

## Step 3 — Redeploy the Cloud Functions

From the project root (`flight-tracker/`):

```bash
firebase deploy --only functions
```

### What happens during deployment

Firebase will prompt you to enter each secret value to store in Google Cloud Secret Manager:

```
? Enter a string value for TRAVELPAYOUTS_TOKEN: [paste your token]
? Enter a string value for TELEGRAM_TOKEN: [paste your Telegram bot token]
```

These are stored securely and never appear in logs or code.

### After deployment

```
✔  functions[checkFlightPrices]: Successful update
✔  functions[getLivePrice]: Successful update
✔  functions[sendTestTelegram]: Successful update
```

---

## Step 4 — Verify it's working

### Force a manual test run

Rather than waiting for the scheduled time:

1. Go to **Firebase Console → Functions**
2. Click the three-dot menu next to `checkFlightPrices`
3. Click **View in Cloud Scheduler**
4. Click the **Force run** (▶) button

Then check the logs:

```bash
firebase functions:log --only checkFlightPrices
```

### What good logs look like

```
Starting scheduled flight price check at 2025-08-10 08:00 EDT
Processing 3 tracked flights
Fetched price for JFK-LHR: 342 USD per person × 2 = 684 USD
Fetched price for DUB-JFK: 480 USD per person × 1 = 480 USD
Flight price check completed successfully
```

You should also receive a Telegram message for each tracked flight.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Travelpayouts fetch error` | Token wrong | Re-check `TRAVELPAYOUTS_TOKEN` in Secret Manager |
| `No price bucket found` | Route has no data yet | Try again later; some routes have sparse cached data |
| `Travelpayouts returned no data` | API issue or bad IATA codes | Verify codes are correct (3-letter, e.g. `JFK`, `LHR`) |
| No Telegram message | Token or chat ID wrong | Use **Send Test** button on any flight card in the UI |
| Secrets not picked up after deploy | Prompt was skipped | Set manually (see below) then redeploy |

### Manually set a secret (if the deploy prompt was skipped)

```bash
firebase functions:secrets:set TRAVELPAYOUTS_TOKEN
# Paste your token when prompted

firebase functions:secrets:set TELEGRAM_TOKEN
# Paste your Telegram bot token when prompted

firebase deploy --only functions
```

---

## Files changed (summary)

| File | What changed |
|---|---|
| `functions/index.js` | Removed Amadeus; uses Travelpayouts Data API only |
| `functions/.env` | Updated with `TRAVELPAYOUTS_TOKEN` + `TELEGRAM_TOKEN` |
| `README.md` | Updated throughout to reflect new setup |

No frontend files touched. No Firestore schema changes. No new npm packages needed.

---

## Schedule reference

The function currently runs at **8am and 8pm UTC** (`0 8,20 * * *`).

> If you want 8am/8pm in your local timezone, update `functions/index.js` to use the
> `timeZone` parameter and redeploy:
>
> ```javascript
> exports.checkFlightPrices = onSchedule(
>   { schedule: '0 8,20 * * *', timeZone: 'America/New_York' },
>   async (event) => {
> ```
>
> Firebase handles DST automatically when `timeZone` is set.
