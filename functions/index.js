const {onSchedule} = require('firebase-functions/v2/scheduler');
const {onCall} = require('firebase-functions/v2/https');
const {defineString} = require('firebase-functions/params');
const admin = require('firebase-admin');
const axios = require('axios');
const moment = require('moment-timezone');

// Define parameters
const travelpayoutsToken    = defineString('TRAVELPAYOUTS_TOKEN');
const telegramToken         = defineString('TELEGRAM_TOKEN');
const googlePriceFetcherUrl = defineString('GOOGLE_PRICE_FETCHER_URL');
const googlePriceSecret     = defineString('GOOGLE_PRICE_SECRET');

admin.initializeApp();
const db = admin.firestore();

/**
 * Extract the minimum price from a Travelpayouts v1 /cheap response.
 * Shape: { data: { "CITYCODE": { "0": { price, ... }, "1": { price, ... } } } }
 */
function extractMinPrice(data) {
  const keys = Object.keys(data);
  if (keys.length === 0) return null;
  const bucket = data[keys[0]];
  if (!bucket || Object.keys(bucket).length === 0) return null;
  const prices = Object.values(bucket).map(e => e.price).filter(p => p > 0);
  if (prices.length === 0) return null;
  return Math.min(...prices);
}

/**
 * Fetch prices from:
 *   1. Travelpayouts /v1/prices/cheap  → cheapPrice (best cached)
 *   2. Google Flights via Cloud Run    → googlePrice (real live prices)
 *
 * Returns { cheapPrice, googlePrice, googlePriceLevel, googleFlightsList, topFlight }
 * Any field may be null if no data.
 */
async function fetchPrice(flight) {
  const totalPassengers = (flight.adults || 1) + (flight.children || 0);
  const currency = 'usd';
  const token = travelpayoutsToken.value();

  const departureMonth = flight.departureDate ? flight.departureDate.substring(0, 7) : null;
  const returnMonth    = flight.returnDate    ? flight.returnDate.substring(0, 7)    : null;

  const baseParams = { origin: Array.isArray(flight.origin) ? flight.origin[0] : flight.origin, destination: flight.destination, currency, token };
  if (departureMonth) baseParams.depart_date = departureMonth;
  if (returnMonth)    baseParams.return_date  = returnMonth;

  const headers = { 'X-Access-Token': token };

  // Google Flights via Cloud Run — runs in parallel with cheap
  const googlePricePromise = (async () => {
    const url = googlePriceFetcherUrl.value();
    if (!url) return null;
    try {
      const resp = await axios.post(`${url}/price`, {
        origin:              flight.origin,         // string OR array for multi-airport
        destination:         flight.destination,
        departureDate:       flight.departureDate,
        returnDate:          flight.returnDate || null,
        adults:              flight.adults || 1,
        children:            flight.children || 0,
        stopsPreference:     flight.stopsPreference || 'any',
        departureTimeStart:  flight.departureTimeStart || null,
        departureTimeEnd:    flight.departureTimeEnd || null,
        maxDurationHours:    flight.maxDurationHours || null
      }, {
        headers: {
          'Content-Type': 'application/json',
          'X-Price-Secret': googlePriceSecret.value()
        },
        timeout: 20000
      });
      return resp.data ?? null;
    } catch (e) {
      console.warn(`[${flight.origin}-${flight.destination}] Cloud Run error: ${e.message}`);
      return null;
    }
  })();

  // Run both in parallel
  const [cheapRes, googleRes] = await Promise.allSettled([
    axios.get('https://api.travelpayouts.com/v1/prices/cheap', { headers, params: baseParams }),
    googlePricePromise
  ]);

  // ── Extract cheap price ────────────────────────────────────────────────────
  let cheapPrice = null;
  if (cheapRes.status === 'fulfilled' && cheapRes.value.data?.success && cheapRes.value.data?.data) {
    const raw = extractMinPrice(cheapRes.value.data.data);
    if (raw) cheapPrice = parseFloat((raw * totalPassengers).toFixed(2));
  }
  if (cheapPrice === null) {
    // Retry without date filter
    try {
      const fallback = await axios.get('https://api.travelpayouts.com/v1/prices/cheap', {
        headers,
        params: { origin: Array.isArray(flight.origin) ? flight.origin[0] : flight.origin, destination: flight.destination, currency, token }
      });
      if (fallback.data?.success && fallback.data?.data) {
        const raw = extractMinPrice(fallback.data.data);
        if (raw) cheapPrice = parseFloat((raw * totalPassengers).toFixed(2));
      }
    } catch (e) { /* leave null */ }
  }

  // ── Extract Google price ───────────────────────────────────────────────────
  let googlePrice = null;
  let googlePriceLevel = null;
  let googleFlightsList = [];
  let topFlight = null;

  if (googleRes.status === 'fulfilled' && googleRes.value !== null) {
    const gData = googleRes.value;
    if (typeof gData.googlePrice === 'number' && gData.googlePrice > 0) {
      googlePrice = parseFloat(gData.googlePrice.toFixed(2));
      googlePriceLevel = gData.priceLevel ?? null;
    }
    googleFlightsList = Array.isArray(gData.flights) ? gData.flights : [];
    topFlight = gData.topFlight || null;
  }

  console.log(
    `[${flight.origin}-${flight.destination}] ` +
    `google: ${googlePrice ?? 'n/a'} (${googlePriceLevel ?? '?'}), ` +
    `cheap: ${cheapPrice ?? 'n/a'} USD (×${totalPassengers} pax), ` +
    `${googleFlightsList.length} flights returned`
  );

  return { cheapPrice, googlePrice, googlePriceLevel, googleFlightsList, topFlight };
}

/**
 * Compute price trend using statistical z-score (uses primary price history)
 */
async function computePriceTrend(flightId) {
  const snapshot = await db.collection("priceHistory")
    .where("flightId", "==", flightId)
    .orderBy("checkedAt", "desc")
    .limit(20)
    .get();

  const prices = snapshot.docs.map(d => d.data().price);
  if (prices.length < 5) return 0;

  const historicalPrices = prices.slice(1);
  if (historicalPrices.length === 0) return 0;

  const mean = historicalPrices.reduce((a, b) => a + b, 0) / historicalPrices.length;
  const variance = historicalPrices.map(p => Math.pow(p - mean, 2)).reduce((a, b) => a + b, 0) / historicalPrices.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;

  const latest = prices[0];
  return Math.abs((latest - mean) / std);
}

/**
 * Send Telegram notification with price alert details + top flight info
 */
async function sendTelegramNotification(flight, prices, trendScore, triggerType, topFlight = null) {
  const { cheapPrice, googlePrice, googlePriceLevel, bestGooglePrice = null, isNewBestGoogle = false } = prices;
  const cur = 'USD';
  const adults   = flight.adults || 1;
  const children = flight.children || 0;
  const passengers = adults + children;

  // Booking URLs
  let googleFlightsUrl;
  if (flight.returnDate) {
    googleFlightsUrl = `https://www.google.com/travel/flights?q=flights%20from%20${flight.origin}%20to%20${flight.destination}%20on%20${flight.departureDate}%20return%20${flight.returnDate}%20${adults}%20adult${adults > 1 ? 's' : ''}${children > 0 ? '%20' + children + '%20child' + (children > 1 ? 'ren' : '') : ''}`;
  } else {
    googleFlightsUrl = `https://www.google.com/travel/flights?q=flights%20from%20${flight.origin}%20to%20${flight.destination}%20on%20${flight.departureDate}%20${adults}%20adult${adults > 1 ? 's' : ''}${children > 0 ? '%20' + children + '%20child' + (children > 1 ? 'ren' : '') : ''}`;
  }

  // Price lines
  const priceLineItems = [];
  if (googlePrice != null) {
    priceLineItems.push(`  ✈️ Google: $${googlePrice.toFixed(2)}${googlePriceLevel ? ' (' + googlePriceLevel + ')' : ''}`);
  }
  if (bestGooglePrice != null) {
    if (isNewBestGoogle) {
      priceLineItems.push(`  🏆 Best ever: $${bestGooglePrice.toFixed(2)} — NEW BEST!`);
    } else if (googlePrice != null && googlePrice > bestGooglePrice) {
      const abovePct = ((googlePrice - bestGooglePrice) / bestGooglePrice * 100).toFixed(1);
      priceLineItems.push(`  📊 Best ever: $${bestGooglePrice.toFixed(2)} (+${abovePct}% above)`);
    } else {
      priceLineItems.push(`  🏆 Best ever: $${bestGooglePrice.toFixed(2)}`);
    }
  }
  const priceLines = priceLineItems.join('\n');

  // Top flight details (compact)
  const stopsLabel = topFlight
    ? (topFlight.stops === 0 ? 'Nonstop' : `${topFlight.stops} stop${topFlight.stops > 1 ? 's' : ''}`)
    : '';
  const flightDetailsBlock = topFlight
    ? `\n\n🛫 ${topFlight.airline} · ${stopsLabel} · ${topFlight.duration}\n` +
      `  ${topFlight.departure} → ${topFlight.arrival} · ${topFlight.price}`
    : '';

  const originDisplay = Array.isArray(flight.origin) ? flight.origin.join('/') : flight.origin;

  const msg =
    `🚨 ${originDisplay} → ${flight.destination} (${flight.departureDate})\n\n` +
    `Prices (${passengers} pax):\n${priceLines}${flightDetailsBlock}\n\n` +
    `🔗 Google Flights: ${googleFlightsUrl}`;

  try {
    await axios.post(
      `https://api.telegram.org/bot${telegramToken.value()}/sendMessage`,
      { chat_id: flight.telegramChatId, text: msg }
    );
    console.log(`Telegram notification sent to ${flight.telegramChatId}`);
  } catch (err) {
    console.error("Telegram send error:", err.response?.data || err.message);
  }
}

/**
 * Scheduled function — 6am, 12pm, 6pm ET daily
 */
exports.checkFlightPrices = onSchedule({ schedule: '0 6,12,18 * * *', timeZone: 'America/New_York', timeoutSeconds: 540 }, async (event) => {
  const now = moment.tz('America/New_York');
  console.log(`Starting scheduled flight price check at ${now.format('YYYY-MM-DD HH:mm z')}`);

  try {
    const flightsSnap = await db.collection("trackedFlights").get();
    console.log(`Processing ${flightsSnap.docs.length} tracked flights`);

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    for (const doc of flightsSnap.docs) {
      const flight = doc.data();

      if (!flight.alertEnabled) {
        console.log(`Skipping disabled flight ${doc.id}`);
        continue;
      }

      // Skip flights whose departure date has already passed
      const today = moment.tz('America/New_York').format('YYYY-MM-DD');
      if (flight.departureDate && flight.departureDate < today) {
        console.log(`Skipping expired flight ${doc.id}: departed ${flight.departureDate}`);
        continue;
      }

      // Fetch price — retry up to twice with 3s gap if Google returns n/a
      let { cheapPrice, googlePrice, googlePriceLevel, googleFlightsList, topFlight } = await fetchPrice(flight);
      for (let attempt = 1; attempt <= 2 && googlePrice === null; attempt++) {
        console.log(`[${flight.origin}-${flight.destination}] Google n/a, retry ${attempt}/2 in 3s...`);
        await sleep(3000);
        const retry = await fetchPrice(flight);
        if (retry.googlePrice !== null) {
          ({ cheapPrice, googlePrice, googlePriceLevel, googleFlightsList, topFlight } = retry);
          console.log(`[${flight.origin}-${flight.destination}] Retry ${attempt} succeeded: ${googlePrice}`);
        }
      }

      // Delay between flights to avoid rate limiting on Google Flights scraper
      await sleep(30000);

      // Primary price: Google first, fall back to cheap
      const primaryPrice = googlePrice ?? cheapPrice ?? null;

      if (primaryPrice === null) {
        console.warn(`Skipping flight ${doc.id}: no price data from any source`);
        continue;
      }

      // Store price history
      await db.collection("priceHistory").add({
        flightId: doc.id,
        price: primaryPrice,
        googlePrice: googlePrice ?? null,
        googlePriceLevel: googlePriceLevel ?? null,
        cheapPrice: cheapPrice ?? null,
        checkedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const trendScore = await computePriceTrend(doc.id);

      // Compute best Google price seen since tracking started
      const prevBestGoogle = flight.bestGooglePrice ?? null;
      // Only true when we're beating an existing best (not recording first-ever price)
      const isNewBestGoogle = googlePrice !== null && prevBestGoogle !== null && googlePrice < prevBestGoogle;
      const newBestGooglePrice = googlePrice !== null
        ? (prevBestGoogle !== null ? Math.min(prevBestGoogle, googlePrice) : googlePrice)
        : prevBestGoogle;

      let sendAlert = false;
      let triggerType = "";

      // New all-time best always triggers an alert (only when beating a known previous best)
      if (isNewBestGoogle) {
        sendAlert = true;
        triggerType = 'new all-time best Google price';
      }

      // Check for Google price drop vs last stored value (cache price excluded from alerts)
      const priceChecks = [
        { label: 'Google Flights', current: googlePrice, last: flight.lastGooglePrice }
      ];
      for (const { label, current, last } of priceChecks) {
        if (current != null && last != null && last > 0) {
          const dropPercent = ((last - current) / last) * 100;
          if (dropPercent >= flight.alertPercentage) {
            sendAlert = true;
            triggerType += (triggerType ? ', ' : '') + `${label} price drop (${dropPercent.toFixed(1)}%)`;
          }
        }
      }

      if (sendAlert) {
        await sendTelegramNotification(flight, { cheapPrice, googlePrice, googlePriceLevel, bestGooglePrice: newBestGooglePrice, isNewBestGoogle }, trendScore, triggerType, topFlight);
      } else {
        console.log(`No alert for ${doc.id} (google: ${googlePrice ?? 'n/a'}, cheap: ${cheapPrice ?? 'n/a'}, trend: ${trendScore.toFixed(2)})`);
      }

      // Update tracked flight
      await doc.ref.update({
        lastPrice:            primaryPrice,
        lastGooglePrice:      googlePrice ?? null,
        lastGooglePriceLevel: googlePriceLevel ?? null,
        lastCheapPrice:       cheapPrice ?? null,
        lastGoogleFlights:    googleFlightsList.length > 0 ? googleFlightsList : [],
        lastChecked:          admin.firestore.FieldValue.serverTimestamp(),
        bestGooglePrice:      newBestGooglePrice
      });

      // Be polite to APIs
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log("Flight price check completed successfully");
  } catch (err) {
    console.error("checkFlightPrices error:", err);
  }

  return null;
});

/**
 * Callable: get live price on demand
 */
exports.getLivePrice = onCall(async (request) => {
  const flightId = request.data.flightId;
  if (!flightId) throw new Error('flightId is required');

  console.log(`Getting live price for flight ${flightId}`);

  try {
    const flightDoc = await db.collection('trackedFlights').doc(flightId).get();
    if (!flightDoc.exists) throw new Error('Flight not found');

    const flight = flightDoc.data();
    const { cheapPrice, googlePrice, googlePriceLevel, googleFlightsList, topFlight } = await fetchPrice(flight);

    const primaryPrice = googlePrice ?? cheapPrice ?? null;

    if (primaryPrice === null) {
      const reason = 'No price data found — Travelpayouts may not have cached pricing and Google Flights returned no results. Try again later.';
      console.warn(`getLivePrice: no price for ${flight.origin}-${flight.destination}`);
      return {
        success: false,
        noData: true,
        reason,
        flight: { origin: flight.origin, destination: flight.destination }
      };
    }

    console.log(`Live prices — google: ${googlePrice ?? 'n/a'}, cheap: ${cheapPrice ?? 'n/a'} USD`);

    const prevBestGoogle = flight.bestGooglePrice ?? null;
    const newBestGooglePrice = googlePrice !== null
      ? (prevBestGoogle !== null ? Math.min(prevBestGoogle, googlePrice) : googlePrice)
      : prevBestGoogle;

    await db.collection('priceHistory').add({
      flightId,
      price: primaryPrice,
      googlePrice: googlePrice ?? null,
      googlePriceLevel: googlePriceLevel ?? null,
      cheapPrice: cheapPrice ?? null,
      checkedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await flightDoc.ref.update({
      lastPrice:            primaryPrice,
      lastGooglePrice:      googlePrice ?? null,
      lastGooglePriceLevel: googlePriceLevel ?? null,
      lastCheapPrice:       cheapPrice ?? null,
      lastGoogleFlights:    googleFlightsList.length > 0 ? googleFlightsList : [],
      lastChecked:          admin.firestore.FieldValue.serverTimestamp(),
      bestGooglePrice:      newBestGooglePrice
    });

    console.log('Prices added to history and flight updated');

    return {
      success: true,
      price: primaryPrice,
      googlePrice: googlePrice ?? null,
      googlePriceLevel: googlePriceLevel ?? null,
      cheapPrice: cheapPrice ?? null,
      currency: 'USD',
      flight: {
        origin: flight.origin,
        destination: flight.destination,
        departureDate: flight.departureDate,
        returnDate: flight.returnDate
      }
    };
  } catch (err) {
    console.error('getLivePrice error:', err);
    throw new Error(`Failed to get live price: ${err.message}`);
  }
});

/**
 * Callable: send test Telegram notification
 */
exports.sendTestTelegram = onCall(async (request) => {
  const flightId = request.data.flightId;
  if (!flightId) throw new Error('flightId is required');

  console.log(`Sending test Telegram for flight ${flightId}`);

  try {
    const flightDoc = await db.collection('trackedFlights').doc(flightId).get();
    if (!flightDoc.exists) throw new Error('Flight not found');

    const flight = flightDoc.data();
    const originDisplay = Array.isArray(flight.origin) ? flight.origin.join('/') : flight.origin;

    const testMessage =
      `🧪 Test Alert: ${originDisplay} → ${flight.destination} (${flight.departureDate})\n` +
      `This is a test notification from your Flight Price Tracker.\n` +
      `Last Google Price: ${flight.lastGooglePrice ? flight.lastGooglePrice.toFixed(2) + ' USD' : 'N/A'}\n` +
      `Best Google Ever:  ${flight.bestGooglePrice ? flight.bestGooglePrice.toFixed(2) + ' USD' : 'N/A'}\n` +
      `Last Best Cached: ${flight.lastCheapPrice ? flight.lastCheapPrice.toFixed(2) + ' USD' : 'N/A'}\n` +
      `Alert Threshold: ${flight.alertPercentage}%`;

    await axios.post(
      `https://api.telegram.org/bot${telegramToken.value()}/sendMessage`,
      { chat_id: flight.telegramChatId, text: testMessage }
    );

    console.log(`Test Telegram sent to ${flight.telegramChatId}`);
    return { success: true, chatId: flight.telegramChatId, message: testMessage };
  } catch (err) {
    console.error('sendTestTelegram error:', err.response?.data || err);
    throw new Error(`Failed to send test Telegram: ${err.message}`);
  }
});
