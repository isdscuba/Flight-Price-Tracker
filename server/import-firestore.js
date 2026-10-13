// One-off: import a Firestore REST export (trackedFlights.json / priceHistory.json)
// into the local SQLite database. Usage: node import-firestore.js <dir-with-json>
const fs = require('fs');
const path = require('path');
const store = require('./db');

function decode(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return new Date(v.timestampValue).toISOString();
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)]));
  throw new Error('Unsupported Firestore value: ' + JSON.stringify(v));
}
const docToObj = d => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, decode(v)]));
const docId = d => d.name.split('/').pop();

const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'backup'));
const flights = JSON.parse(fs.readFileSync(path.join(dir, 'trackedFlights.json'), 'utf8'));
const history = JSON.parse(fs.readFileSync(path.join(dir, 'priceHistory.json'), 'utf8'));

if (store.listFlights().length > 0) {
  console.error('Database already has flights; refusing to import over them.');
  process.exit(1);
}

const run = store.db.transaction(() => {
  for (const d of flights) store.insertFlight(docToObj(d), docId(d));
  for (const d of history) {
    const h = docToObj(d);
    if (h.price == null || !h.checkedAt) continue;
    store.addHistory(h.flightId, h, h.checkedAt);
  }
});
run();
console.log(`Imported ${flights.length} flights and ${history.length} history rows.`);
