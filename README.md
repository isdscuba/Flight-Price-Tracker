# Flight Price Tracker

A comprehensive flight price tracking application with cloud backend, real-time price monitoring, statistical trend detection, and Telegram notifications.

## Features

- Track flight prices for multiple routes
- Twice-daily automated price checks via Firebase Cloud Functions (8am + 8pm ET)
- Statistical trend detection using z-score analysis
- Telegram notifications for price alerts and regular updates
- Beautiful, responsive web UI inspired by major flight search engines
- Real-time data synchronization with Firestore
- Interactive price history charts
- Customizable alert thresholds per flight

## Architecture

- **Backend**: Firebase Cloud Functions (Node.js 20)
- **Database**: Firestore (NoSQL cloud database)
- **Scheduler**: Cloud Scheduler (triggers twice-daily price checks)
- **API**: Travelpayouts Data API (free) — Aviasales flight price data
- **Notifications**: Telegram Bot API
- **Frontend**: Vanilla HTML/CSS/JavaScript with Firebase SDK

## Prerequisites

1. Node.js 20+ and npm
2. Firebase CLI (`npm install -g firebase-tools`)
3. A Google account for Firebase
4. Travelpayouts account (free — [sign up here](https://www.travelpayouts.com/))
5. Telegram account

---

## Setup Instructions

### Step 1: Firebase Project Setup

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Add project" and follow the wizard:
   - Enter a project name (e.g., "flight-tracker")
   - Enable/disable Google Analytics (optional)
   - Click "Create project"

3. Enable Firestore Database:
   - In Firebase Console, go to "Firestore Database"
   - Click "Create database"
   - Choose "Start in production mode"
   - Select a location (choose closest to you)
   - Click "Enable"

4. Get your Firebase configuration:
   - Go to Project Settings (gear icon) > General
   - Scroll down to "Your apps"
   - Click the web icon `</>`
   - Register your app with a nickname (e.g., "flight-tracker-web")
   - Copy the `firebaseConfig` object
   - Update `public/config.js` with these values

5. Enable Cloud Functions and Cloud Scheduler:
   - Go to Functions in Firebase Console
   - Click "Get started" and follow upgrade prompts if needed
   - Upgrade to Blaze (pay-as-you-go) plan - required for Cloud Functions
   - Note: Free tier is generous; you likely won't be charged for personal use

### Step 2: Travelpayouts API Setup

1. Go to [Travelpayouts](https://www.travelpayouts.com/) and create a free account
2. Once logged in, go to your **Developer / API token page**:
   `https://www.travelpayouts.com/developers/api`
   *(The token is in your Profile — not in the Programs/Tools affiliate section)*
3. Copy your **API token** (a 32-character string). Click "Update token" to generate one if empty.
4. Save it for the next step

> **Note**: The Travelpayouts Data API is free with no approval process. It returns cached prices updated multiple times per day — ideal for twice-daily monitoring.

### Step 3: Telegram Bot Setup

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` command
3. Follow prompts to choose a name and username for your bot
4. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
5. Search for `@userinfobot` in Telegram
6. Send `/start` to get your chat ID (numeric value)
7. Go back to your bot and send `/start` to initialize it
8. Save both the bot token and your chat ID

### Step 4: Local Project Setup

1. Clone or download this project to your machine
2. Navigate to the project directory:
   ```bash
   cd /path/to/flight-tracker
   ```

3. Update `.firebaserc` with your Firebase project ID:
   ```json
   {
     "projects": {
       "default": "your-project-id"
     }
   }
   ```

4. Update `public/config.js` with your Firebase config:
   ```javascript
   const firebaseConfig = {
     apiKey: "your-api-key",
     authDomain: "your-project-id.firebaseapp.com",
     projectId: "your-project-id",
     storageBucket: "your-project-id.appspot.com",
     messagingSenderId: "your-sender-id",
     appId: "your-app-id"
   };
   ```

5. Update `functions/.env` file with your credentials:
   ```bash
   # Edit functions/.env and replace with your actual values
   TRAVELPAYOUTS_TOKEN=your_travelpayouts_api_token_here
   KIWI_API_KEY=your_kiwi_tequila_api_key_here
   TELEGRAM_TOKEN=your_telegram_bot_token_here
   ```

6. Install Firebase Functions dependencies:
   ```bash
   cd functions
   npm install
   cd ..
   ```

7. Login to Firebase CLI:
   ```bash
   firebase login
   ```

### Step 5: Deploy to Firebase

1. Deploy Firestore rules and indexes:
   ```bash
   firebase deploy --only firestore
   ```

2. Deploy Cloud Functions (will prompt for environment variables):
   ```bash
   firebase deploy --only functions
   ```

   Note:
   - First deployment may take several minutes
   - You'll be prompted to enter values for TRAVELPAYOUTS_TOKEN and TELEGRAM_TOKEN
   - These will be stored securely in Google Cloud Secret Manager
   - The values are already in your functions/.env file for reference

3. Deploy hosting (optional, for remote access):
   ```bash
   firebase deploy --only hosting
   ```

### Step 6: Setup Cloud Scheduler

The Cloud Function is configured to run on schedule, but you need to ensure Cloud Scheduler is enabled:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your Firebase project
3. Navigate to "Cloud Scheduler"
4. If prompted, enable the API
5. The function `checkFlightPrices` should appear with schedule `0 8,20 * * *` (8am + 8pm ET)
6. If not visible, run:
   ```bash
   firebase deploy --only functions
   ```
   And check again

### Step 7: Run the UI Locally

1. Navigate to the public directory:
   ```bash
   cd public
   ```

2. Start a local web server. You can use any of these methods:

   **Option A: Python (if installed)**
   ```bash
   python3 -m http.server 8000
   ```

   **Option B: Node.js http-server**
   ```bash
   npx http-server -p 8000
   ```

   **Option C: Firebase hosting emulator**
   ```bash
   firebase serve --only hosting
   ```

3. Open your browser and go to `http://localhost:8000` (or the port shown)

4. You should see the Flight Price Tracker UI

---

## Usage Guide

### Adding a Flight to Track

1. Fill out the form with:
   - **From/To**: 3-letter IATA airport codes (e.g., JFK, LAX, LHR)
   - **Departure**: Select a future date
   - **Return**: Optional, must be after departure
   - **Passengers**: Number of adult passengers (1-9)
   - **Currency**: Desired currency for prices
   - **Alert Threshold**: Percentage drop to trigger alert (1-100%)
   - **Telegram Chat ID**: Your Telegram chat ID from @userinfobot

2. Click "Track This Flight"

3. The flight will appear in the tracked flights list below

### Understanding the Dashboard

Each tracked flight card shows:
- **Route and dates**: Origin → Destination with travel dates
- **Status**: Active (alerts enabled) or Paused (alerts disabled)
- **Current Price**: Latest price from Travelpayouts API (total for all passengers)
- **Alert Threshold**: Percentage drop that will trigger notification
- **Trend Score**: Statistical anomaly indicator (0-5+)
  - 0-1 (green): Normal price variation
  - 1-2 (yellow): Moderate change
  - 2+ (red): Significant anomaly (triggers alert)
- **Last Checked**: Timestamp of last price check
- **Price History Chart**: Visual representation of price changes over time

### Editing a Flight

1. Click the "Edit" button on any flight card
2. Modify alert threshold, Telegram chat ID, or enable/disable alerts
3. Click "Save Changes"

### Deleting a Flight

1. Click the "Delete" button on any flight card
2. Confirm the deletion
3. Flight will be removed (price history is preserved in database)

### Notifications

You will receive Telegram notifications in two scenarios:

**1. Price Alerts**
- Sent when price drops by ≥ your alert threshold percentage
- Sent when trend score exceeds 2 (statistical anomaly)
- Message includes: new price, trend score, and trigger reason

**2. Regular Updates (sent at 8am and 8pm ET)**
- Sent every run if no alert was triggered
- Message includes: current price and trend score
- Only sent if alerts are enabled for that flight

---

## How It Works

### Twice-Daily Price Check Process

1. Cloud Scheduler triggers `checkFlightPrices` at 8am and 8pm ET
2. For each tracked flight (with alerts enabled):
   - Fetches price from Travelpayouts Data API
   - Price is per-person and multiplied by total passenger count
   - Stores best price in `priceHistory` collection with timestamp
   - Calculates trend score using z-score of last 20 prices
   - Checks if price drop ≥ alert threshold
   - Checks if trend score > 2 (anomaly)
   - Sends Telegram alert if either condition met, otherwise sends regular update
   - Updates `lastPrice` and `lastChecked` in flight document

### Statistical Trend Detection

The system uses z-score analysis to detect unusual price changes:

```
z = (current_price - mean_of_last_20) / standard_deviation
```

- **z < 1**: Normal variation (green)
- **1 ≤ z < 2**: Moderate change (yellow)
- **z ≥ 2**: Significant anomaly (red, triggers alert)

This catches both sudden drops and unusual spikes compared to historical patterns.

### Data Model

**trackedFlights Collection**
```javascript
{
  origin: "JFK",              // IATA code
  destination: "LAX",         // IATA code
  departureDate: "2026-02-10", // YYYY-MM-DD
  returnDate: null,           // YYYY-MM-DD or null
  adults: 1,                  // Integer
  currency: "USD",            // ISO currency
  lastPrice: 450.00,          // Float or null
  lastChecked: Timestamp,     // Firestore Timestamp
  alertPercentage: 5,         // Integer 1-100
  telegramChatId: "123456",   // String
  alertEnabled: true          // Boolean
}
```

**priceHistory Collection**
```javascript
{
  flightId: "doc_id",         // Reference to trackedFlights
  price: 450.00,              // Float
  checkedAt: Timestamp        // Firestore Timestamp
}
```

---

## Cost Considerations

### Firebase (Blaze Plan)

**Free Tier Limits (Monthly)**
- Cloud Functions: 2M invocations, 400K GB-sec, 200K CPU-sec
- Firestore: 50K reads, 20K writes, 20K deletes, 1GB storage
- Hosting: 10GB transfer, 360MB storage

**Expected Usage (per flight)**
- 2 function invocations/day = 60/month
- 2 Firestore writes/day = 60/month
- Minimal reads (UI-driven)

For 1-10 flights, you'll stay well within free tier with room to spare.

### Travelpayouts Data API

**Free Tier**
- No hard monthly limit documented
- Default rate limit: 200 requests/hour per IP
- Cached data updated multiple times daily

**Expected Usage**
- Each flight: 2 checks/day = ~60 calls/month
- 10 flights = ~600 calls/month — comfortably within limits
- No approval required, no paid tier needed for personal use

### Telegram

- Completely free, no limits for personal use

---

## Customization

### Change Check Times

Edit the schedule in `functions/index.js`:

```javascript
// 6am and 10pm ET instead of 8am and 8pm
exports.checkFlightPrices = onSchedule('0 6,22 * * *', async (event) => { ...

// Three times a day: 8am, 1pm, 8pm
exports.checkFlightPrices = onSchedule('0 8,13,20 * * *', async (event) => { ...
```

Then redeploy: `firebase deploy --only functions`

### Add More Currencies

Edit `public/index.html`, add options to currency select:

```html
<option value="CHF">CHF - Swiss Franc</option>
<option value="CNY">CNY - Chinese Yuan</option>
```

---

## Troubleshooting

**Note on Configuration**: This project uses Firebase Functions v2 with the params package for environment variables. Credentials are stored securely in Google Cloud Secret Manager, not in the deprecated Runtime Config service.

### No prices showing up

1. Check Cloud Functions logs:
   ```bash
   firebase functions:log
   ```

2. Look for errors like:
   - "Travelpayouts fetch error" → Check your TRAVELPAYOUTS_TOKEN is correct
   - "No price bucket found" → Verify IATA codes and that the route exists in Travelpayouts
   - "Travelpayouts returned no data" → Route may have sparse cached data; try again later

3. Manually trigger function for testing:
   - Go to Firebase Console > Functions
   - Click on `checkFlightPrices`
   - Click "Test function" (may need to enable)

### Not receiving Telegram notifications

1. Verify bot token is correct in `functions/.env`

2. Ensure you've sent `/start` to your bot

3. Double-check chat ID is correct (numeric only)

4. Check Function logs for "Telegram send error"

### UI not loading flights

1. Open browser console (F12) and check for errors

2. Verify `public/config.js` has correct Firebase configuration

3. Check Firestore rules are deployed:
   ```bash
   firebase deploy --only firestore:rules
   ```

4. Ensure you're connected to the internet

### "Function deployment failed"

1. Ensure you're on Blaze (pay-as-go) plan

2. Check Node.js version in `functions/package.json` matches your environment

3. Clear functions cache:
   ```bash
   cd functions
   rm -rf node_modules package-lock.json
   npm install
   cd ..
   firebase deploy --only functions
   ```

### Charts not displaying

1. Verify price history exists (flights need to be checked at least once)

2. Check browser console for Chart.js errors

3. Ensure Firestore indexes are deployed:
   ```bash
   firebase deploy --only firestore:indexes
   ```

---

## Security Notes

**⚠️ WARNING**: The default Firestore security rules allow anyone with your project ID to read/write data. This is acceptable for personal projects but **NOT for production**.

For production use, implement authentication:

1. Enable Firebase Authentication (Email/Password or Google)
2. Update `firestore.rules`:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```
3. Add authentication to the UI

---

## File Structure

```
flight-tracker/
├── functions/
│   ├── index.js              # Cloud Function code
│   ├── package.json          # Dependencies
│   └── .gitignore
├── public/
│   ├── index.html            # Main UI
│   ├── styles.css            # Styling
│   ├── app.js                # Frontend logic
│   └── config.js             # Firebase configuration
├── firebase.json             # Firebase project configuration
├── .firebaserc               # Firebase project ID
├── firestore.rules           # Database security rules
├── firestore.indexes.json    # Database indexes
└── README.md                 # This file
```

---

## Common IATA Airport Codes

| Code | Airport |
|------|---------|
| JFK  | New York (John F. Kennedy) |
| LAX  | Los Angeles |
| LHR  | London Heathrow |
| CDG  | Paris Charles de Gaulle |
| NRT  | Tokyo Narita |
| SYD  | Sydney |
| DXB  | Dubai |
| SIN  | Singapore |
| ORD  | Chicago O'Hare |
| ATL  | Atlanta |

Find more codes: [IATA Code Search](https://www.iata.org/en/publications/directories/code-search/)

---

## Future Enhancements

Potential improvements you could implement:

- Multi-user support with Firebase Authentication
- Email notifications in addition to Telegram
- Filter flights by airline or non-stop only
- Absolute price thresholds ($50 drop, not just %)
- CSV export of price history
- Predictive analytics / ML for price forecasting
- Flexible date search (±3 days)
- Mobile app (React Native + Firebase)
- Browser notifications (Web Push API)
- Price comparison with other booking sites

---

## Support

For issues with:
- **Firebase**: [Firebase Documentation](https://firebase.google.com/docs)
- **Travelpayouts API**: [Data API Docs](https://travelpayouts.github.io/slate/)
- **This project**: Check logs, review configuration, ensure all setup steps completed

---

## License

This project is provided as-is for personal use. Travelpayouts API usage subject to their terms of service.

---

## Changelog

**v1.1.0** - Migrated from Amadeus to Travelpayouts
- Switched to Travelpayouts Data API (free, no approval)
- Changed from hourly to twice-daily checks (8am + 8pm ET)
- Simplified scheduler logic — every run now sends an update or alert
- Removed Amadeus OAuth token management

**v1.0.0** - Initial release
- Hourly price checking via Amadeus API
- Telegram notifications
- Statistical trend detection
- Modern responsive UI
- Real-time Firestore sync
- Interactive price charts

---

Enjoy tracking your flights! ✈️
