const store = require('./db');

const FETCHER_URL = process.env.FETCHER_URL || 'http://127.0.0.1:4331';
const FETCHER_SECRET = process.env.PRICE_SECRET || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TZ = 'America/New_York';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// fli Scanner is currently rejected by Google for every request (upstream break), so it is
// off by default; set ENABLE_FLI=1 to try it again.
const ENABLE_FLI = process.env.ENABLE_FLI === '1';

// Global pacing: every price fetch (scheduled, retry, or UI button) waits for a slot at
// least MIN_GAP_MS (+ jitter) after the previous one, so Google never sees a burst.
const MIN_GAP_MS = parseInt(process.env.MIN_FETCH_GAP_MS || '15000', 10);
let nextSlot = 0;
async function gate() {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + MIN_GAP_MS + Math.floor(Math.random() * 5000);
  if (start > now) await sleep(start - now);
}

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
  await gate();
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

  const [gData, fData] = await Promise.all([call('/price', 'Google'), ENABLE_FLI ? call('/fli-price', 'fli') : null]);

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

function fallbackUrl(flight, origin) {
  const adults = flight.adults || 1;
  const children = flight.children || 0;
  const pax = `%20${adults}%20adult${adults > 1 ? 's' : ''}` +
    (children > 0 ? `%20${children}%20child${children > 1 ? 'ren' : ''}` : '');
  const ret = flight.returnDate ? `%20return%20${flight.returnDate}` : '';
  return `https://www.google.com/travel/flights?q=flights%20from%20${origin}%20to%20${flight.destination}%20on%20${flight.departureDate}${ret}${pax}`;
}

/** Google Flights deep link (?tfs=) for the exact search; origin = the airport that won. */
async function bookingUrl(flight, origin) {
  const orig = origin || (Array.isArray(flight.origin) ? flight.origin[0] : flight.origin);
  try {
    const r = await postJson(`${FETCHER_URL}/link`, {
      origin: orig, destination: flight.destination, departureDate: flight.departureDate,
      returnDate: flight.returnDate || null, adults: flight.adults || 1, children: flight.children || 0,
      stopsPreference: flight.stopsPreference || 'any'
    }, FETCHER_SECRET ? { 'X-Price-Secret': FETCHER_SECRET } : {}, 15000);
    return r.url;
  } catch (e) {
    console.warn(`link build failed: ${e.message}`);
    return fallbackUrl(flight, orig);
  }
}

/** PNG price-history chart for a flight, or null if there isn't enough history. */
async function buildChart(flight) {
  const rows = store.getHistory(flight.id);
  if (rows.length < 2) return null;
  const origin = Array.isArray(flight.origin) ? flight.origin.join('/') : flight.origin;
  const dates = flight.returnDate ? `${flight.departureDate} → ${flight.returnDate}` : flight.departureDate;
  try {
    const resp = await fetch(`${FETCHER_URL}/chart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(FETCHER_SECRET ? { 'X-Price-Secret': FETCHER_SECRET } : {}) },
      body: JSON.stringify({
        title: `${origin} → ${flight.destination}`,
        subtitle: `${dates} · ${rows.length} checks`,
        points: rows.map(r => ({ t: r.checkedAt, price: r.price })),
        bestEver: flight.bestPrice ?? null
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    console.warn(`chart build failed: ${e.message}`);
    return null;
  }
}

async function tgCall(method, body, isForm = false) {
  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: isForm ? undefined : { 'Content-Type': 'application/json' },
    body: isForm ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  if (!resp.ok) throw new Error(`Telegram ${method} HTTP ${resp.status}: ${await resp.text()}`);
}

/** Send text; if a chart PNG is given, send it as a photo with the text as caption (<=1024 chars). */
async function sendTelegram(chatId, text, photo = null) {
  if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN is not set');
  if (photo) {
    try {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('photo', new Blob([photo], { type: 'image/png' }), 'history.png');
      if (text.length <= 1024) {
        form.append('caption', text);
        return await tgCall('sendPhoto', form, true);
      }
      await tgCall('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
      return await tgCall('sendPhoto', form, true);
    } catch (e) {
      console.warn(`photo send failed, falling back to text: ${e.message}`);
    }
  }
  await tgCall('sendMessage', { chat_id: chatId, text });
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
  const link = await bookingUrl(flight, topFlight?.origin);

  const msg = `🚨 ${origin} → ${flight.destination} (${flight.departureDate})\n\n` +
    `${bestHeader}\nAll Prices:\n${lines.join('\n')}${detail}\n\n🔗 ${link}`;

  try {
    await sendTelegram(flight.telegramChatId, msg, await buildChart(store.getFlight(flight.id) || flight));
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
          const backoff = attempt === 1 ? 20000 : 60000;
          console.log(`[${flight.origin}-${flight.destination}] Google n/a, retry ${attempt}/2 in ${backoff / 1000}s...`);
          await sleep(backoff);
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

        await sleep(8000 + Math.floor(Math.random() * 7000)); // extra spacing between flights (on top of the global gate)
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
    await sleep(attempt === 1 ? 10000 : 30000);
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
    `Alert Threshold: ${flight.alertPercentage}%\n\n` +
    `🔗 ${await bookingUrl(flight)}`;
  await sendTelegram(flight.telegramChatId, msg, await buildChart(flight));
  return { success: true };
}

module.exports = { checkAllFlights, getLivePrice, fetchInitialPrice, sendTestTelegram, computePriceTrend };
