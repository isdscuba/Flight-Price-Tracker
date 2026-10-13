const store = require('./db');

const FETCHER_URL = process.env.FETCHER_URL || 'http://127.0.0.1:4331';
const FETCHER_SECRET = process.env.PRICE_SECRET || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TZ = 'America/New_York';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayET() {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

async function postJson(url, body, headers, timeoutMs) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/**
 * Fetch prices from the local Python service:
 *   /price      Google Flights (fast_flights scraper)
 *   /fli-price  fli Scanner (reverse-engineered Google Flights API)
 * Any field may be null if no data.
 */
async function fetchPrice(flight) {
  const payload = {
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
  const headers = FETCHER_SECRET ? { 'X-Price-Secret': FETCHER_SECRET } : {};
  const label = `[${flight.origin}-${flight.destination}]`;

  const call = async (endpoint, name) => {
    try {
      return await postJson(`${FETCHER_URL}${endpoint}`, payload, headers, 50000);
    } catch (e) {
      console.warn(`${label} ${name} error: ${e.message}`);
      return null;
    }
  };

  const [gData, fData] = await Promise.all([call('/price', 'Google'), call('/fli-price', 'fli')]);

  let googlePrice = null, googlePriceLevel = null, googleFlightsList = [], topFlight = null;
  if (gData) {
    if (typeof gData.googlePrice === 'number' && gData.googlePrice > 0) {
      googlePrice = parseFloat(gData.googlePrice.toFixed(2));
      googlePriceLevel = gData.priceLevel ?? null;
    }
    googleFlightsList = Array.isArray(gData.flights) ? gData.flights : [];
    topFlight = gData.topFlight || null;
  }

  let fliPrice = null, fliTopFlight = null, fliFlightsList = [];
  if (fData) {
    if (typeof fData.fliPrice === 'number' && fData.fliPrice > 0) {
      fliPrice = parseFloat(fData.fliPrice.toFixed(2));
    }
    fliFlightsList = Array.isArray(fData.flights) ? fData.flights : [];
    fliTopFlight = fData.topFlight || null;
  }

  console.log(`${label} google: ${googlePrice ?? 'n/a'} (${googlePriceLevel ?? '?'}), fli: ${fliPrice ?? 'n/a'}`);
  return { googlePrice, googlePriceLevel, googleFlightsList, topFlight, fliPrice, fliTopFlight, fliFlightsList };
}

/** z-score of the latest price vs the previous 19 checks. */
function computePriceTrend(flightId) {
  const prices = store.recentPrices(flightId, 20);
  if (prices.length < 5) return 0;
  const hist = prices.slice(1);
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const variance = hist.map(p => (p - mean) ** 2).reduce((a, b) => a + b, 0) / hist.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return Math.abs((prices[0] - mean) / std);
}

function pickBest({ googlePrice, fliPrice }) {
  const candidates = [
    { price: googlePrice, source: 'Google Flights' },
    { price: fliPrice,    source: 'fli Scanner' }
  ].filter(c => c.price !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.price <= b.price ? a : b));
}

function bookingUrl(flight) {
  const adults = flight.adults || 1;
  const children = flight.children || 0;
  const pax = `%20${adults}%20adult${adults > 1 ? 's' : ''}` +
    (children > 0 ? `%20${children}%20child${children > 1 ? 'ren' : ''}` : '');
  const ret = flight.returnDate ? `%20return%20${flight.returnDate}` : '';
  return `https://www.google.com/travel/flights?q=flights%20from%20${flight.origin}%20to%20${flight.destination}%20on%20${flight.departureDate}${ret}${pax}`;
}

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN is not set');
  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) throw new Error(`Telegram HTTP ${resp.status}: ${await resp.text()}`);
}

async function sendAlert(flight, prices, topFlight) {
  const {
    googlePrice, googlePriceLevel, fliPrice, primaryPrice, primaryPriceSource,
    bestPrice = null, bestPriceSource = null, isNewBestPrice = false
  } = prices;
  const passengers = (flight.adults || 1) + (flight.children || 0);

  const bestHeader = primaryPrice != null && primaryPriceSource
    ? `Best Price (${passengers} pax): $${primaryPrice.toFixed(2)} ✅ ${primaryPriceSource}\n` : '';

  const rows = [
    { label: '✈️ Google Flights', price: googlePrice, level: googlePriceLevel, id: 'Google Flights' },
    { label: '🔍 fli Scanner',    price: fliPrice,    level: null,             id: 'fli Scanner' }
  ];
  const lines = rows.filter(s => s.price != null).map(s =>
    `  ${s.label}: $${s.price.toFixed(2)}${s.level ? ` (${s.level})` : ''}${s.id === primaryPriceSource ? '  ✅' : ''}`);

  if (bestPrice != null) {
    const via = bestPriceSource ? ` via ${bestPriceSource}` : '';
    if (isNewBestPrice) {
      lines.push(`  🏆 Best ever: $${bestPrice.toFixed(2)} — NEW BEST!${via}`);
    } else if (primaryPrice != null && primaryPrice > bestPrice) {
      const above = ((primaryPrice - bestPrice) / bestPrice * 100).toFixed(1);
      lines.push(`  📊 Best ever: $${bestPrice.toFixed(2)} (+${above}% above)${via}`);
    } else {
      lines.push(`  🏆 Best ever: $${bestPrice.toFixed(2)}${via}`);
    }
  }

  const stops = topFlight ? (topFlight.stops === 0 ? 'Nonstop' : `${topFlight.stops} stop${topFlight.stops > 1 ? 's' : ''}`) : '';
  const detail = topFlight
    ? `\n\n🛫 ${topFlight.airline} · ${stops} · ${topFlight.duration}\n  ${topFlight.departure} → ${topFlight.arrival} · ${topFlight.price}` : '';
  const origin = Array.isArray(flight.origin) ? flight.origin.join('/') : flight.origin;

  const msg = `🚨 ${origin} → ${flight.destination} (${flight.departureDate})\n\n` +
    `${bestHeader}\nAll Prices:\n${lines.join('\n')}${detail}\n\n🔗 Google Flights: ${bookingUrl(flight)}`;

  try {
    await sendTelegram(flight.telegramChatId, msg);
    console.log(`Telegram notification sent to ${flight.telegramChatId}`);
  } catch (err) {
    console.error('Telegram send error:', err.message);
  }
}

function flightUpdateFields(r, best, extra) {
  return {
    lastPrice:            best.price,
    lastPriceSource:      best.source,
    lastGooglePrice:      r.googlePrice ?? null,
    lastGooglePriceLevel: r.googlePriceLevel ?? null,
    lastFliPrice:         r.fliPrice ?? null,
    lastGoogleFlights:    r.googleFlightsList.length > 0 ? r.googleFlightsList : [],
    lastChecked:          new Date().toISOString(),
    ...extra
  };
}

/** Scheduled check of every active, non-departed flight. Sends alerts. */
let checkRunning = false;
async function checkAllFlights() {
  if (checkRunning) { console.log('Price check already running, skipping'); return; }
  checkRunning = true;
  try {
    console.log(`Starting scheduled flight price check at ${new Date().toISOString()}`);
    store.setMeta('lastRun', new Date().toISOString());
    const flights = store.listFlights();
    console.log(`Processing ${flights.length} tracked flights`);

    for (const flight of flights) {
      try {
        if (!flight.alertEnabled) { console.log(`Skipping disabled flight ${flight.id}`); continue; }
        if (flight.departureDate && flight.departureDate < todayET()) {
          console.log(`Skipping expired flight ${flight.id}: departed ${flight.departureDate}`); continue;
        }

        let r = await fetchPrice(flight);
        for (let attempt = 1; attempt <= 2 && r.googlePrice === null; attempt++) {
          console.log(`[${flight.origin}-${flight.destination}] Google n/a, retry ${attempt}/2 in 3s...`);
          await sleep(3000);
          const retry = await fetchPrice(flight);
          if (retry.googlePrice !== null) r = retry;
        }

        const best = pickBest(r);
        if (!best) { console.warn(`Skipping flight ${flight.id}: no price data from any source`); continue; }
        const { price: primaryPrice, source: primaryPriceSource } = best;
        const alertTopFlight = primaryPriceSource === 'fli Scanner' ? r.fliTopFlight : r.topFlight;

        store.addHistory(flight.id, { price: primaryPrice, ...r });
        const trendScore = computePriceTrend(flight.id);

        const prevBest = flight.bestPrice ?? null;
        const isNewBestPrice = prevBest !== null && primaryPrice < prevBest;
        const newBestPrice = prevBest !== null ? Math.min(prevBest, primaryPrice) : primaryPrice;
        const newBestPriceSource = isNewBestPrice ? primaryPriceSource : (flight.bestPriceSource ?? primaryPriceSource);
        const prevBestGoogle = flight.bestGooglePrice ?? null;
        const newBestGooglePrice = r.googlePrice !== null
          ? (prevBestGoogle !== null ? Math.min(prevBestGoogle, r.googlePrice) : r.googlePrice)
          : prevBestGoogle;

        let sendIt = false;
        if (isNewBestPrice) sendIt = true;
        if (flight.lastPrice != null && flight.lastPrice > 0) {
          const drop = ((flight.lastPrice - primaryPrice) / flight.lastPrice) * 100;
          if (drop >= flight.alertPercentage) sendIt = true;
        }

        if (sendIt) {
          await sendAlert(flight, {
            googlePrice: r.googlePrice, googlePriceLevel: r.googlePriceLevel, fliPrice: r.fliPrice,
            primaryPrice, primaryPriceSource,
            bestPrice: newBestPrice, bestPriceSource: newBestPriceSource, isNewBestPrice
          }, alertTopFlight);
        } else {
          console.log(`No alert for ${flight.id} (google: ${r.googlePrice ?? 'n/a'}, fli: ${r.fliPrice ?? 'n/a'}, best: ${primaryPrice} via ${primaryPriceSource}, trend: ${trendScore.toFixed(2)})`);
        }

        store.updateFlight(flight.id, flightUpdateFields(r, best, {
          bestGooglePrice: newBestGooglePrice, bestPrice: newBestPrice, bestPriceSource: newBestPriceSource
        }));

        await sleep(10000); // spacing between flights to avoid rate limiting
      } catch (err) {
        console.error(`checkAllFlights error for ${flight.id}:`, err);
      }
    }
    console.log('Flight price check completed');
  } finally {
    checkRunning = false;
  }
}

/** On-demand price fetch (no alerts). Records history. */
async function getLivePrice(flightId) {
  const flight = store.getFlight(flightId);
  if (!flight) throw Object.assign(new Error('Flight not found'), { status: 404 });

  let r = await fetchPrice(flight);
  for (let attempt = 1; attempt <= 2 && r.googlePrice === null; attempt++) {
    await sleep(3000);
    const retry = await fetchPrice(flight);
    if (retry.googlePrice !== null) r = retry;
  }
  const best = pickBest(r);
  if (!best) {
    return {
      success: false, noData: true,
      reason: 'No price data found from any source. Try again later.',
      flight: { origin: flight.origin, destination: flight.destination }
    };
  }
  const { price: primaryPrice, source: primaryPriceSource } = best;

  const prevBest = flight.bestPrice ?? null;
  const newBestPrice = prevBest !== null ? Math.min(prevBest, primaryPrice) : primaryPrice;
  const newBestPriceSource = (prevBest === null || primaryPrice <= prevBest)
    ? primaryPriceSource : (flight.bestPriceSource ?? primaryPriceSource);
  const prevBestGoogle = flight.bestGooglePrice ?? null;
  const newBestGooglePrice = r.googlePrice !== null
    ? (prevBestGoogle !== null ? Math.min(prevBestGoogle, r.googlePrice) : r.googlePrice)
    : prevBestGoogle;

  store.addHistory(flightId, { price: primaryPrice, ...r });
  store.updateFlight(flightId, flightUpdateFields(r, best, {
    bestGooglePrice: newBestGooglePrice, bestPrice: newBestPrice, bestPriceSource: newBestPriceSource
  }));

  return {
    success: true, price: primaryPrice, priceSource: primaryPriceSource,
    googlePrice: r.googlePrice ?? null, googlePriceLevel: r.googlePriceLevel ?? null, fliPrice: r.fliPrice ?? null,
    currency: 'USD',
    flight: { origin: flight.origin, destination: flight.destination, departureDate: flight.departureDate, returnDate: flight.returnDate }
  };
}

/** Initial price fetch for a newly added flight. */
async function fetchInitialPrice(flightId) {
  const flight = store.getFlight(flightId);
  if (!flight) return;
  console.log(`fetchInitialPrice: ${flightId} (${flight.origin}-${flight.destination})`);
  try {
    const r = await fetchPrice(flight);
    const best = pickBest(r);
    if (!best) { console.warn(`fetchInitialPrice: no price data for ${flightId}`); return; }
    store.addHistory(flightId, { price: best.price, ...r });
    store.updateFlight(flightId, flightUpdateFields(r, best, {
      bestGooglePrice: r.googlePrice ?? null, bestPrice: best.price, bestPriceSource: best.source
    }));
  } catch (err) {
    console.error(`fetchInitialPrice error for ${flightId}:`, err);
  }
}

async function sendTestTelegram(flightId) {
  const flight = store.getFlight(flightId);
  if (!flight) throw Object.assign(new Error('Flight not found'), { status: 404 });
  const origin = Array.isArray(flight.origin) ? flight.origin.join('/') : flight.origin;
  const money = v => (v ? '$' + v.toFixed(2) : 'N/A');
  const msg =
    `🧪 Test Alert: ${origin} → ${flight.destination} (${flight.departureDate})\n` +
    `This is a test notification from your Flight Price Tracker.\n\n` +
    `Last Prices:\n` +
    `  ✈️ Google Flights: ${money(flight.lastGooglePrice)}\n` +
    `  🔍 fli Scanner:   ${money(flight.lastFliPrice)}\n\n` +
    `Best Price Ever: ${flight.bestPrice ? money(flight.bestPrice) + ' via ' + (flight.bestPriceSource || '?') : 'N/A'}\n` +
    `Alert Threshold: ${flight.alertPercentage}%`;
  await sendTelegram(flight.telegramChatId, msg);
  return { success: true };
}

module.exports = { checkAllFlights, getLivePrice, fetchInitialPrice, sendTestTelegram, computePriceTrend };
