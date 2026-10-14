const store = require('./db');

const FETCHER_URL = process.env.FETCHER_URL || 'http://127.0.0.1:4331';
const FETCHER_SECRET = process.env.PRICE_SECRET || '';
const FF3_URL = process.env.FF3_URL || 'http://127.0.0.1:4332';
const KIWI_URL = process.env.KIWI_MCP_URL || 'https://mcp.kiwi.com';
const ENABLE_KIWI = process.env.ENABLE_KIWI !== '0';
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


const KIWI_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

async function kiwiRpc(body, timeoutMs) {
  const resp = await fetch(KIWI_URL, {
    method: 'POST', headers: KIWI_HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  const line = text.split('\n').find(l => l.startsWith('data:'));
  return JSON.parse(line ? line.slice(5) : text);
}

const fmtKiwiTime = iso => new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', hour: 'numeric', minute: '2-digit', weekday: 'short', month: 'short', day: 'numeric'
}).formatToParts(new Date(iso + 'Z')).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});

function kiwiWhen(iso) {
  const t = fmtKiwiTime(iso);
  return `${t.hour}:${t.minute} ${t.dayPeriod} on ${t.weekday}, ${t.month} ${t.day}`;
}

/** Kiwi.com (free public MCP, no key). Same filters as the Google sources. */
async function kiwiSearch(flight) {
  if (!ENABLE_KIWI) return null;
  const [y, m, d] = flight.departureDate.split('-');
  const args = {
    flyFrom: [].concat(flight.origin).join(','), flyTo: flight.destination,
    departureDate: `${d}/${m}/${y}`, adults: flight.adults || 1, children: flight.children || 0,
    cabinClass: 'M', currency: 'USD', sort: 'price', exclude_airlines: 'F9,NK'
  };
  if (flight.returnDate) {
    const [ry, rm, rd] = flight.returnDate.split('-');
    args.returnDate = `${rd}/${rm}/${ry}`;
  }
  const stops = { direct: 0, '1stop': 1 }[flight.stopsPreference];
  if (stops !== undefined) args.max_sector_stopovers = stops;
  if (flight.maxDurationHours) args.max_fly_duration = flight.maxDurationHours;
  if (flight.departureTimeStart) args.dtime_from = flight.departureTimeStart;
  if (flight.departureTimeEnd) args.dtime_to = flight.departureTimeEnd;

  await kiwiRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'flight-tracker', version: '2' } } }, 20000);
  const rpc = await kiwiRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search-flight', arguments: args } }, 60000);
  const text = rpc.result?.content?.[0]?.text;
  if (!text || rpc.result?.isError) throw new Error(`Kiwi error: ${(text || JSON.stringify(rpc.error || {})).slice(0, 120)}`);
  const its = (JSON.parse(text).itineraries || []).filter(i => i.price > 0);
  if (its.length === 0) return null;
  const best = its.reduce((a, b) => (a.price <= b.price ? a : b));
  const o = best.outbound;
  const hrs = Math.floor(o.durationSeconds / 3600), mins = Math.round((o.durationSeconds % 3600) / 60);
  return {
    price: best.price, url: best.bookingUrl,
    topFlight: {
      airline: [...new Set((o.segments || []).map(sg => sg.carrierName).filter(Boolean))].join(', ') || 'Kiwi.com',
      price: `$${Math.round(best.price)}`, departure: kiwiWhen(o.departureTime), arrival: kiwiWhen(o.arrivalTime),
      duration: mins ? `${hrs} hr ${mins} min` : `${hrs} hr`, stops: o.stops, origin: o.from
    }
  };
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

  const [gData, fData, kiwi] = await Promise.all([
    call('/price', 'Google'),
    ENABLE_FLI ? call('/fli-price', 'fli') : null,
    kiwiSearch(flight).catch(e => { console.warn(`${label} Kiwi error: ${e.message}`); return null; })
  ]);

  // Second Google parser (fast-flights 3.x). Runs after the first call so Google never sees a burst.
  let ffPrice = null, ffTopFlight = null;
  try {
    const ff = await postJson(`${FF3_URL}/price`, payload, headers, 90000);
    if (typeof ff.googlePrice === 'number' && ff.googlePrice > 0) {
      ffPrice = parseFloat(ff.googlePrice.toFixed(2));
      ffTopFlight = ff.topFlight || null;
    }
  } catch (e) {
    console.warn(`${label} fast-flights 3 error: ${e.message}`);
  }

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

  const kiwiPrice = kiwi ? parseFloat(kiwi.price.toFixed(2)) : null;
  console.log(`${label} google: ${googlePrice ?? 'n/a'}, kiwi: ${kiwiPrice ?? 'n/a'}, ff3: ${ffPrice ?? 'n/a'}${ffPrice !== null && ffPrice === googlePrice ? ' (same)' : ''}, fli: ${fliPrice ?? 'n/a'}`);
  return {
    googlePrice, googlePriceLevel, googleFlightsList, topFlight, fliPrice, fliTopFlight, fliFlightsList,
    kiwiPrice, kiwiTopFlight: kiwi?.topFlight ?? null, kiwiUrl: kiwi?.url ?? null, ffPrice, ffTopFlight
  };
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

const SRC = { google: 'Google Flights', kiwi: 'Kiwi.com', ff: 'Google Flights (alt)', fli: 'fli Scanner' };

/** Cheapest price across sources. The alt Google parser only counts when it differs from the main one. */
function pickBest({ googlePrice, fliPrice, kiwiPrice = null, ffPrice = null }) {
  const candidates = [
    { price: googlePrice, source: SRC.google },
    { price: kiwiPrice,   source: SRC.kiwi },
    { price: ffPrice !== googlePrice ? ffPrice : null, source: SRC.ff },
    { price: fliPrice,    source: SRC.fli }
  ].filter(c => c.price !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.price <= b.price ? a : b));
}

function topFor(source, r) {
  if (source === SRC.kiwi) return r.kiwiTopFlight;
  if (source === SRC.ff) return r.ffTopFlight;
  if (source === SRC.fli) return r.fliTopFlight;
  return r.topFlight;
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
    googlePrice, googlePriceLevel, fliPrice, kiwiPrice = null, ffPrice = null, kiwiUrl = null, primaryPrice, primaryPriceSource,
    bestPrice = null, bestPriceSource = null, isNewBestPrice = false
  } = prices;
  const passengers = (flight.adults || 1) + (flight.children || 0);

  const bestHeader = primaryPrice != null && primaryPriceSource
    ? `Best Price (${passengers} pax): $${primaryPrice.toFixed(2)} ✅ ${primaryPriceSource}\n` : '';

  const rows = [
    { label: '✈️ Google Flights', price: googlePrice, level: googlePriceLevel, id: 'Google Flights' },
    { label: '🛫 Kiwi.com',       price: kiwiPrice,   level: null,             id: SRC.kiwi },
    // second Google parser: only shown when it disagrees with the main one
    { label: '✈️ Google (alt)',   price: ffPrice !== googlePrice ? ffPrice : null, level: null, id: SRC.ff },
    { label: '🔍 fli Scanner',    price: fliPrice,    level: null,             id: SRC.fli }
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
    `${bestHeader}\nAll Prices:\n${lines.join('\n')}${detail}\n\n🔗 ${link}${primaryPriceSource === SRC.kiwi && kiwiUrl ? `\n🎫 Kiwi booking: ${kiwiUrl}` : ''}`;

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
    lastKiwiPrice:        r.kiwiPrice ?? null,
    lastKiwiUrl:          r.kiwiUrl ?? null,
    lastFfPrice:          r.ffPrice ?? null,
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
        for (let attempt = 1; attempt <= 2 && pickBest(r) === null; attempt++) {
          const backoff = attempt === 1 ? 20000 : 60000;
          console.log(`[${flight.origin}-${flight.destination}] no source returned a price, retry ${attempt}/2 in ${backoff / 1000}s...`);
          await sleep(backoff);
          const retry = await fetchPrice(flight);
          if (pickBest(retry) !== null) r = retry;
        }

        const best = pickBest(r);
        if (!best) { console.warn(`Skipping flight ${flight.id}: no price data from any source`); continue; }
        const { price: primaryPrice, source: primaryPriceSource } = best;
        const alertTopFlight = topFor(primaryPriceSource, r);

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
            kiwiPrice: r.kiwiPrice, ffPrice: r.ffPrice, kiwiUrl: r.kiwiUrl,
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
  for (let attempt = 1; attempt <= 2 && pickBest(r) === null; attempt++) {
    await sleep(attempt === 1 ? 10000 : 30000);
    const retry = await fetchPrice(flight);
    if (pickBest(retry) !== null) r = retry;
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
    kiwiPrice: r.kiwiPrice ?? null, ffPrice: r.ffPrice ?? null,
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
    `  🛫 Kiwi.com:      ${money(flight.lastKiwiPrice)}\n` +
    (flight.lastFfPrice && flight.lastFfPrice !== flight.lastGooglePrice ? `  ✈️ Google (alt):  ${money(flight.lastFfPrice)}\n` : '') + '\n' +
    `Best Price Ever: ${flight.bestPrice ? money(flight.bestPrice) + ' via ' + (flight.bestPriceSource || '?') : 'N/A'}\n` +
    `Alert Threshold: ${flight.alertPercentage}%\n\n` +
    `🔗 ${await bookingUrl(flight)}`;
  await sendTelegram(flight.telegramChatId, msg, await buildChart(flight));
  return { success: true };
}

module.exports = { checkAllFlights, getLivePrice, fetchInitialPrice, sendTestTelegram, computePriceTrend };
