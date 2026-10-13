const path = require('path');
const express = require('express');
const cron = require('node-cron');
const store = require('./db');
const prices = require('./prices');

const PORT = parseInt(process.env.PORT || '4330', 10);
// Loopback by default. Set BIND_HOST=0.0.0.0 to serve over Tailscale; the middleware
// below still rejects anything that isn't loopback or Tailscale's CGNAT range, so a
// wide bind can't expose the app to the LAN or internet by itself. (Same model as
// the Bedside analytics dashboard.)
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const TZ = 'America/New_York';
const STARTED_AT = new Date().toISOString();

function isAllowedRemote(ip) {
  const addr = ip.replace(/^::ffff:/, '');
  if (addr === '127.0.0.1' || addr === '::1') return true;
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127; // 100.64.0.0/10
}

const app = express();
app.use((req, res, next) => {
  if (!isAllowedRemote(req.socket.remoteAddress || '')) {
    return res.status(403).send('Forbidden — only accessible via localhost or Tailscale.');
  }
  next();
});
// DNS-rebinding / CSRF guard: the Host must be loopback, a Tailscale IP, or a tailnet
// name, and state-changing requests carrying an Origin must be same-origin.
const HOST_OK = /^(localhost|127\.0\.0\.1|\[::1\]|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net|stacies-macbook-air)(:\d+)?$/i;
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (!HOST_OK.test(host)) return res.status(403).send('Forbidden — unexpected Host header.');
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
    let oh = '';
    try { oh = new URL(origin).host; } catch {}
    if (oh !== host) return res.status(403).send('Forbidden — cross-origin request.');
  }
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(`${req.method} ${req.path}:`, err.message);
  res.status(err.status || 500).json({ error: err.message });
});

const ALLOWED_NEW = ['origin', 'destination', 'departureDate', 'returnDate', 'adults', 'children', 'currency',
  'alertPercentage', 'flightType', 'stopsPreference', 'departureTimeStart', 'departureTimeEnd',
  'maxDurationHours', 'telegramChatId', 'alertEnabled'];
const ALLOWED_EDIT = ['alertPercentage', 'flightType', 'alertEnabled', 'stopsPreference',
  'departureTimeStart', 'departureTimeEnd', 'maxDurationHours'];
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));

app.get('/api/health', (req, res) => res.json({ ok: true, startedAt: STARTED_AT, lastRun: store.getMeta('lastRun') }));

app.get('/api/flights', wrap(async (req, res) => {
  res.json(store.listFlights().map(f => ({ ...f, trendScore: prices.computePriceTrend(f.id) })));
}));

app.post('/api/flights', wrap(async (req, res) => {
  const f = pick(req.body || {}, ALLOWED_NEW);
  if (!f.origin || !f.destination || !f.departureDate) {
    return res.status(400).json({ error: 'origin, destination and departureDate are required' });
  }
  const codes = [].concat(f.origin);
  const bad =
    !codes.every(c => /^[A-Z]{2,4}$/.test(c)) || !/^[A-Z]{2,4}$/.test(f.destination) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(f.departureDate) || (f.returnDate && !/^\d{4}-\d{2}-\d{2}$/.test(f.returnDate)) ||
    ['adults', 'children', 'alertPercentage'].some(k => k in f && !Number.isFinite(f[k]));
  if (bad || codes.length > 5) return res.status(400).json({ error: 'Invalid flight fields' });
  const flight = { lastPrice: null, lastChecked: null, alertEnabled: true, telegramChatId: process.env.TELEGRAM_CHAT_ID, ...f };
  const id = store.insertFlight(flight);
  prices.fetchInitialPrice(id); // fire and forget; the UI picks it up on next refresh
  res.status(201).json({ id, ...flight });
}));

app.patch('/api/flights/:id', wrap(async (req, res) => {
  const updated = store.updateFlight(req.params.id, pick(req.body || {}, ALLOWED_EDIT));
  if (!updated) return res.status(404).json({ error: 'Flight not found' });
  res.json(updated);
}));

app.delete('/api/flights/:id', wrap(async (req, res) => {
  if (!store.deleteFlight(req.params.id)) return res.status(404).json({ error: 'Flight not found' });
  res.json({ ok: true });
}));

app.get('/api/flights/:id/history', wrap(async (req, res) => {
  res.json(store.getHistory(req.params.id));
}));

app.post('/api/flights/:id/live-price', wrap(async (req, res) => {
  res.json(await prices.getLivePrice(req.params.id));
}));

app.post('/api/flights/:id/test-telegram', wrap(async (req, res) => {
  res.json(await prices.sendTestTelegram(req.params.id));
}));

// Manual trigger of the full scheduled run (same as the cron job).
app.post('/api/check-now', (req, res) => {
  prices.checkAllFlights().catch(e => console.error('check-now error:', e));
  res.status(202).json({ started: true });
});

app.listen(PORT, BIND_HOST, () => {
  console.log(`Flight tracker running at http://${BIND_HOST}:${PORT}`);
});

// 6am, 12pm, 6pm ET — same schedule as the old Cloud Scheduler job.
cron.schedule('0 6,12,18 * * *', () => {
  prices.checkAllFlights().catch(e => console.error('scheduled check error:', e));
}, { timezone: TZ });

// Catch-up: if the Mac was asleep/off through a slot, run once shortly after startup.
const lastRun = store.getMeta('lastRun');
if (!lastRun || Date.now() - new Date(lastRun).getTime() > 8 * 3600 * 1000) {
  setTimeout(() => prices.checkAllFlights().catch(e => console.error('catch-up check error:', e)), 30000);
}
