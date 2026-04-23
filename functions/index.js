const {onSchedule} = require('firebase-functions/v2/scheduler');
const {onCall} = require('firebase-functions/v2/https');
const {defineString} = require('firebase-functions/params');
const admin = require('firebase-admin');
const axios = require('axios');
const moment = require('moment-timezone');

// Define parameters
const telegramToken         = defineString('TELEGRAM_TOKEN');
const googlePriceFetcherUrl = defineString('GOOGLE_PRICE_FETCHER_URL');
const googlePriceSecret     = defineString('GOOGLE_PRICE_SECRET');

admin.initializeApp();
const db = admin.firestore();

/**
 * Fetch prices from:
 *   1. Google Flights via Cloud Run → googlePrice (fast_flights scraper)
 *   2. fli Scanner via Cloud Run    → fliPrice (reverse-engineered Google Flights API)
 *
 * Returns { googlePrice, googlePriceLevel, googleFlightsList, topFlight,
 *           fliPrice, fliTopFlight, fliFlightsList }
 * Any field may be null if no data.
 */
async function fetchPrice(flight) {
  const flightPayload = {
    origin:             flight.origin,
    destination:        flight.destination,
    departureDate:      flight.departureDate,
    returnDate:         flight.returnDate || null,
    adults:             flight.adults || 1,
    children:           flight.children || 0,
    stopsPreference:    flight.stopsPreference || 'any',
    departureTimeStart: flight.departureTimeStart || null,
    departureTimeEnd:   flight.departureTimeEnd || null,
    maxDurationHours:   flight.maxDurationHours || null
  };

  const cloudRunHeaders = {
    'Content-Type': 'application/json',
    'X-Price-Secret': googlePriceSecret.value()
  };

  // Google Flights via Cloud Run scraper (fast_flights)
  const googlePricePromise = (async () => {
    const url = googlePriceFetcherUrl.value();
    if (!url) return null;
    try {
      const resp = await axios.post(`${url}/price`, flightPayload, { headers: cloudRunHeaders, timeout: 20000 });
      return resp.data ?? null;
    } catch (e) {
      console.warn(`[${flight.origin}-${flight.destination}] Google Cloud Run error: ${e.message}`);
      return null;
    }
  })();

  // fli Scanner — 2nd Google Flights source (reverse-engineered API, same Cloud Run service)
  const fliPricePromise = (async () => {
    const url = googlePriceFetcherUrl.value();
    if (!url) return null;
    try {
      const resp = await axios.post(`${url}/fli-price`, flightPayload, { headers: cloudRunHeaders, timeout: 20000 });
      return resp.data ?? null;
    } catch (e) {
      console.warn(`[${flight.origin}-${flight.destination}] fli error: ${e.message}`);
      return null;
    }
  })();

  // Run both in parallel
  const [googleRes, fliRes] = await Promise.allSettled([googlePricePromise, fliPricePromise]);

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

  // ── Extract fli price ──────────────────────────────────────────────────────
  let fliPrice = null;
  let fliTopFlight = null;
  let fliFlightsList = [];

  if (fliRes.status === 'fulfilled' && fliRes.value !== null) {
    const fData = fliRes.value;
    if (typeof fData.fliPrice === 'number' && fData.fliPrice > 0) {
      fliPrice = parseFloat(fData.fliPrice.toFixed(2));
    }
    fliFlightsList = Array.isArray(fData.flights) ? fData.flights : [];
    fliTopFlight = fData.topFlight || null;
  }

  console.log(
    `[${flight.origin}-${flight.destination}] ` +
    `google: ${googlePrice ?? 'n/a'} (${googlePriceLevel ?? '?'}), ` +
    `fli: ${fliPrice ?? 'n/a'}`
  );

  return { googlePrice, googlePriceLevel, googleFlightsList, topFlight, fliPrice, fliTopFlight, fliFlightsList };
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
 * Send Telegram notification with price alert details + top flight info.
 * prices: { googlePrice, googlePriceLevel, fliPrice,
 *           primaryPrice, primaryPriceSource, bestPrice, bestPriceSource, isNewBestPrice }
 */
async function sendTelegramNotification(flight, prices, trendScore, triggerType, topFlight = null) {
  const {
    googlePrice, googlePriceLevel, fliPrice,
    primaryPrice, primaryPriceSource,
    bestPrice = null, bestPriceSource = null, isNewBestPrice = false
  } = prices;
  const adults     = flight.adults || 1;
  const children   = flight.children || 0;
  const passengers = adults + children;

  // Booking URL
  let googleFlightsUrl;
  if (flight.returnDate) {
    googleFlightsUrl = `https://www.google.com/travel/flights?q=flights%20from%20${flight.origin}%20to%20${flight.destination}%20on%20${flight.departureDate}%20return%20${flight.returnDate}%20${adults}%20adult${adults > 1 ? 's' : ''}${children > 0 ? '%20' + children + '%20child' + (children > 1 ? 'ren' : '') : ''}`;
  } else {
    googleFlightsUrl = `https://www.google.com/travel/flights?q=flights%20from%20${flight.origin}%20to%20${flight.destination}%20on%20${flight.departureDate}%20${adults}%20adult${adults > 1 ? 's' : ''}${children > 0 ? '%20' + children + '%20child' + (children > 1 ? 'ren' : '') : ''}`;
  }

  // Best price header line
  const bestHeader = primaryPrice != null && primaryPriceSource
    ? `Best Price (${passengers} pax): $${primaryPrice.toFixed(2)} ✅ ${primaryPriceSource}\n`
    : '';

  // Per-source price rows
  const sourceRows = [
    { label: '✈️ Google Flights', price: googlePrice, level: googlePriceLevel, id: 'Google Flights' },
    { label: '🔍 fli Scanner',    price: fliPrice,    level: null,             id: 'fli Scanner' }
  ];
  const priceLineItems = sourceRows
    .filter(s => s.price != null)
    .map(s => {
      const levelStr = s.level ? ` (${s.level})` : '';
      const winMark  = s.id === primaryPriceSource ? '  ✅' : '';
      return `  ${s.label}: $${s.price.toFixed(2)}${levelStr}${winMark}`;
    });

  // All-time best price line
  if (bestPrice != null) {
    const sourceStr = bestPriceSource ? ` via ${bestPriceSource}` : '';
    if (isNewBestPrice) {
      priceLineItems.push(`  🏆 Best ever: $${bestPrice.toFixed(2)} — NEW BEST!${sourceStr}`);
    } else if (primaryPrice != null && primaryPrice > bestPrice) {
      const abovePct = ((primaryPrice - bestPrice) / bestPrice * 100).toFixed(1);
      priceLineItems.push(`  📊 Best ever: $${bestPrice.toFixed(2)} (+${abovePct}% above)${sourceStr}`);
    } else {
      priceLineItems.push(`  🏆 Best ever: $${bestPrice.toFixed(2)}${sourceStr}`);
    }
  }

  // Top flight detail block
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
    `${bestHeader}\nAll Prices:\n${priceLineItems.join('\n')}${flightDetailsBlock}\n\n` +
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
      let { googlePrice, googlePriceLevel, googleFlightsList, topFlight, fliPrice, fliTopFlight, fliFlightsList } = await fetchPrice(flight);
      for (let attempt = 1; attempt <= 2 && googlePrice === null; attempt++) {
        console.log(`[${flight.origin}-${flight.destination}] Google n/a, retry ${attempt}/2 in 3s...`);
        await sleep(3000);
        const retry = await fetchPrice(flight);
        if (retry.googlePrice !== null) {
          ({ googlePrice, googlePriceLevel, googleFlightsList, topFlight, fliPrice, fliTopFlight, fliFlightsList } = retry);
          console.log(`[${flight.origin}-${flight.destination}] Retry ${attempt} succeeded: ${googlePrice}`);
        }
      }

      // Delay between flights to avoid rate limiting on Google Flights scraper
      await sleep(30000);

      // Best price from Google and fli sources
      const candidates = [
        { price: googlePrice, source: 'Google Flights' },
        { price: fliPrice,    source: 'fli Scanner' }
      ].filter(c => c.price !== null);

      if (candidates.length === 0) {
        console.warn(`Skipping flight ${doc.id}: no price data from any source`);
        continue;
      }

      const bestCandidate    = candidates.reduce((a, b) => a.price <= b.price ? a : b);
      const primaryPrice     = bestCandidate.price;
      const primaryPriceSource = bestCandidate.source;

      // topFlight from whichever source won (prefer Google for richer data)
      const alertTopFlight = primaryPriceSource === 'fli Scanner' ? fliTopFlight : topFlight;

      // Store price history
      await db.collection("priceHistory").add({
        flightId:        doc.id,
        price:           primaryPrice,
        googlePrice:     googlePrice ?? null,
        googlePriceLevel: googlePriceLevel ?? null,
        fliPrice:        fliPrice ?? null,
        checkedAt:       admin.firestore.FieldValue.serverTimestamp()
      });

      const trendScore = await computePriceTrend(doc.id);

      // Cross-source best price tracking
      const prevBestPrice  = flight.bestPrice ?? null;
      const isNewBestPrice = prevBestPrice !== null && primaryPrice < prevBestPrice;
      const newBestPrice   = prevBestPrice !== null ? Math.min(prevBestPrice, primaryPrice) : primaryPrice;
      const newBestPriceSource = isNewBestPrice ? primaryPriceSource : (flight.bestPriceSource ?? primaryPriceSource);

      // Keep Google-only best for chart continuity
      const prevBestGoogle     = flight.bestGooglePrice ?? null;
      const newBestGooglePrice = googlePrice !== null
        ? (prevBestGoogle !== null ? Math.min(prevBestGoogle, googlePrice) : googlePrice)
        : prevBestGoogle;

      let sendAlert = false;
      let triggerType = "";

      // New all-time best across any source (only fires when beating a known previous best)
      if (isNewBestPrice) {
        sendAlert = true;
        triggerType = `new all-time best price via ${primaryPriceSource}`;
      }

      // Price drop vs last recorded best price (any source)
      if (flight.lastPrice != null && flight.lastPrice > 0) {
        const dropPercent = ((flight.lastPrice - primaryPrice) / flight.lastPrice) * 100;
        if (dropPercent >= flight.alertPercentage) {
          sendAlert = true;
          triggerType += (triggerType ? ', ' : '') + `${primaryPriceSource} price drop (${dropPercent.toFixed(1)}%)`;
        }
      }

      if (sendAlert) {
        await sendTelegramNotification(
          flight,
          { googlePrice, googlePriceLevel, fliPrice, primaryPrice, primaryPriceSource, bestPrice: newBestPrice, bestPriceSource: newBestPriceSource, isNewBestPrice },
          trendScore, triggerType, alertTopFlight
        );
      } else {
        console.log(`No alert for ${doc.id} (google: ${googlePrice ?? 'n/a'}, fli: ${fliPrice ?? 'n/a'}, best: ${primaryPrice} via ${primaryPriceSource}, trend: ${trendScore.toFixed(2)})`);
      }

      // Update tracked flight
      await doc.ref.update({
        lastPrice:            primaryPrice,
        lastPriceSource:      primaryPriceSource,
        lastGooglePrice:      googlePrice ?? null,
        lastGooglePriceLevel: googlePriceLevel ?? null,
        lastFliPrice:         fliPrice ?? null,
        lastGoogleFlights:    googleFlightsList.length > 0 ? googleFlightsList : [],
        lastChecked:          admin.firestore.FieldValue.serverTimestamp(),
        bestGooglePrice:      newBestGooglePrice,
        bestPrice:            newBestPrice,
        bestPriceSource:      newBestPriceSource
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
    const { googlePrice, googlePriceLevel, googleFlightsList, topFlight, fliPrice, fliTopFlight, fliFlightsList } = await fetchPrice(flight);

    const candidates = [
      { price: googlePrice, source: 'Google Flights' },
      { price: fliPrice,    source: 'fli Scanner' }
    ].filter(c => c.price !== null);

    if (candidates.length === 0) {
      const reason = 'No price data found from any source. Try again later.';
      console.warn(`getLivePrice: no price for ${flight.origin}-${flight.destination}`);
      return {
        success: false,
        noData: true,
        reason,
        flight: { origin: flight.origin, destination: flight.destination }
      };
    }

    const bestCandidate    = candidates.reduce((a, b) => a.price <= b.price ? a : b);
    const primaryPrice     = bestCandidate.price;
    const primaryPriceSource = bestCandidate.source;

    console.log(`Live prices — google: ${googlePrice ?? 'n/a'}, fli: ${fliPrice ?? 'n/a'} USD — best: ${primaryPrice} via ${primaryPriceSource}`);

    const prevBestPrice  = flight.bestPrice ?? null;
    const newBestPrice   = prevBestPrice !== null ? Math.min(prevBestPrice, primaryPrice) : primaryPrice;
    const newBestPriceSource = (prevBestPrice === null || primaryPrice <= prevBestPrice)
      ? primaryPriceSource
      : (flight.bestPriceSource ?? primaryPriceSource);

    const prevBestGoogle     = flight.bestGooglePrice ?? null;
    const newBestGooglePrice = googlePrice !== null
      ? (prevBestGoogle !== null ? Math.min(prevBestGoogle, googlePrice) : googlePrice)
      : prevBestGoogle;

    await db.collection('priceHistory').add({
      flightId,
      price:           primaryPrice,
      googlePrice:     googlePrice ?? null,
      googlePriceLevel: googlePriceLevel ?? null,
      fliPrice:        fliPrice ?? null,
      checkedAt:       admin.firestore.FieldValue.serverTimestamp()
    });

    await flightDoc.ref.update({
      lastPrice:            primaryPrice,
      lastPriceSource:      primaryPriceSource,
      lastGooglePrice:      googlePrice ?? null,
      lastGooglePriceLevel: googlePriceLevel ?? null,
      lastFliPrice:         fliPrice ?? null,
      lastGoogleFlights:    googleFlightsList.length > 0 ? googleFlightsList : [],
      lastChecked:          admin.firestore.FieldValue.serverTimestamp(),
      bestGooglePrice:      newBestGooglePrice,
      bestPrice:            newBestPrice,
      bestPriceSource:      newBestPriceSource
    });

    console.log('Prices added to history and flight updated');

    return {
      success: true,
      price:           primaryPrice,
      priceSource:     primaryPriceSource,
      googlePrice:     googlePrice ?? null,
      googlePriceLevel: googlePriceLevel ?? null,
      fliPrice:        fliPrice ?? null,
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
      `This is a test notification from your Flight Price Tracker.\n\n` +
      `Last Prices:\n` +
      `  ✈️ Google Flights: ${flight.lastGooglePrice ? '$' + flight.lastGooglePrice.toFixed(2) : 'N/A'}\n` +
      `  🔍 fli Scanner:   ${flight.lastFliPrice    ? '$' + flight.lastFliPrice.toFixed(2)    : 'N/A'}\n` +
      `  📊 Travelpayouts: ${flight.lastCheapPrice  ? '$' + flight.lastCheapPrice.toFixed(2)  : 'N/A'}\n\n` +
      `Best Price Ever: ${flight.bestPrice ? '$' + flight.bestPrice.toFixed(2) + ' via ' + (flight.bestPriceSource || '?') : 'N/A'}\n` +
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
