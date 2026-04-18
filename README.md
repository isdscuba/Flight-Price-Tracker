# Firebase Flight Price Tracker

Tracks flight prices on a schedule and sends Telegram alerts when prices drop or behave unusually. Built on Firebase — the backend runs in the cloud, the UI is a static web page you open in a browser.

## What it does

- Add flights to track with origin, destination, dates, and alert thresholds
- Checks prices twice a day (8am and 8pm ET by default) via the Travelpayouts Data API
- Sends a Telegram message every check — an alert if something significant changed, a brief update if not
- Detects unusual price movements using z-score analysis against the last 20 data points
- Shows price history as charts in the UI

## Third-party APIs

**Travelpayouts Data API** — This is what powers the price data. Travelpayouts is an affiliate travel platform (owned by Aviasales) that exposes cached flight prices for free. It's not a real-time booking API — prices are updated multiple times a day but may lag live fares by a few hours. Free, no approval required, no paid tier needed for personal use. Sign up at [travelpayouts.com](https://www.travelpayouts.com/).

**`fast_flights` (Python, `functions-python/main.py`)** — The repo also contains an experimental Python backend using the [`fast_flights`](https://github.com/AWeirdDev/flights) library, which scrapes Google Flights directly. This is a third-party scraper, not an official API. It's included as an alternative price source but is not the default backend. Use it with awareness: scrapers can break when the target site changes, and terms of service may apply.

**Telegram Bot API** — For notifications. Free, no limits for personal use.

## Architecture

```
Cloud Scheduler (cron: 0 8,20 * * *)
  → Firebase Cloud Function (Node.js 20)
    → Travelpayouts Data API (price fetch per flight)
    → z-score check against last 20 prices (Firestore)
    → Telegram alert or update
    → Firestore write (price history)

Browser
  → Firebase Hosting (static HTML/JS)
  → Firestore SDK (real-time reads)
```

## Setup

### 1. Firebase project

1. Create a new project at [console.firebase.google.com](https://console.firebase.google.com/)
2. Enable Firestore (production mode)
3. Upgrade to Blaze (pay-as-you-go) — required for Cloud Functions. Free tier usage for this project is minimal; you almost certainly won't be charged for personal use
4. Register a web app in Project Settings, copy the `firebaseConfig` object
5. Update `public/config.js` with those values

### 2. Travelpayouts API token

1. Create a free account at [travelpayouts.com](https://www.travelpayouts.com/)
2. Go to Profile > API token (the token is in your profile, not the affiliate programs section)
3. Copy the 32-character token

### 3. Telegram bot

1. Message `@BotFather` on Telegram, send `/newbot`
2. Follow prompts to get a bot token
3. Message `@userinfobot` to get your chat ID
4. Send `/start` to your new bot to initialize it

### 4. Local setup

```bash
# Install Firebase CLI
npm install -g firebase-tools
firebase login

# Install function dependencies
cd functions && npm install && cd ..

# Update .firebaserc with your project ID
# Update public/config.js with your Firebase config
# Update functions/.env with your credentials:
#   TRAVELPAYOUTS_TOKEN=your_token
#   TELEGRAM_TOKEN=your_bot_token
```

### 5. Deploy

```bash
# Deploy everything
firebase deploy

# Or deploy individually
firebase deploy --only firestore
firebase deploy --only functions
firebase deploy --only hosting
```

### 6. Run the UI locally

```bash
cd public
python3 -m http.server 8000
# or: npx http-server -p 8000
```

Open `http://localhost:8000`.

## Changing check times

Edit the schedule in `functions/index.js`:

```js
// Default: 8am and 8pm ET
exports.checkFlightPrices = onSchedule('0 8,20 * * *', async (event) => {

// Three times a day: 6am, 1pm, 9pm
exports.checkFlightPrices = onSchedule('0 6,13,21 * * *', async (event) => {
```

The schedule uses standard cron syntax in UTC. The default `0 8,20` assumes ET (UTC-4/UTC-5 depending on DST) — adjust accordingly for your timezone. After changing, redeploy: `firebase deploy --only functions`.

## Statistical alert logic

Each price check calculates a z-score against the last 20 stored prices:

```
z = (current_price - mean) / standard_deviation
```

- z < 1: normal, sends a regular update
- 1 <= z < 2: moderate change
- z >= 2: significant anomaly, triggers an alert

An alert also fires if the price drops by more than your configured alert threshold percentage.

## Cost

For 1-10 flights, everything stays within Firebase's free tier. Firestore writes (2/day per flight) and Cloud Function invocations (2/day total) are well under the monthly limits. You're unlikely to see any charges for personal use.

Travelpayouts and Telegram are free.

## File structure

```
flight-tracker/
├── functions/
│   ├── index.js              # Cloud Function (price checks, alerts)
│   └── package.json
├── functions-python/
│   ├── main.py               # Experimental Python backend (fast_flights scraper)
│   └── requirements.txt
├── public/
│   ├── index.html            # UI
│   ├── app.js                # Frontend logic
│   ├── styles.css
│   └── config.js             # Firebase config (not committed)
├── firebase.json
├── .firebaserc
├── firestore.rules
└── firestore.indexes.json
```

## License

MIT. Note: `fast_flights` (the Google Flights scraper in `functions-python/`) is an independent open-source library with its own MIT license. Travelpayouts API usage is subject to [their terms of service](https://www.travelpayouts.com/terms).
