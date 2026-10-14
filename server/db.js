const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'flights.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS flights (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id    TEXT NOT NULL,
    price        REAL NOT NULL,
    google_price REAL,
    google_level TEXT,
    fli_price    REAL,
    checked_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_flight ON history (flight_id, checked_at);
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// additive migrations
const histCols = db.prepare("PRAGMA table_info(history)").all().map(c => c.name);
for (const col of ['kiwi_price', 'ff_price']) {
  if (!histCols.includes(col)) db.exec(`ALTER TABLE history ADD COLUMN ${col} REAL`);
}

const newId = () => crypto.randomBytes(10).toString('hex');

function listFlights() {
  return db.prepare('SELECT id, data FROM flights').all()
    .map(r => ({ id: r.id, ...JSON.parse(r.data) }));
}

function getFlight(id) {
  const r = db.prepare('SELECT id, data FROM flights WHERE id = ?').get(id);
  return r ? { id: r.id, ...JSON.parse(r.data) } : null;
}

function insertFlight(data, id = newId()) {
  db.prepare('INSERT INTO flights (id, data) VALUES (?, ?)').run(id, JSON.stringify(data));
  return id;
}

function updateFlight(id, patch) {
  const cur = getFlight(id);
  if (!cur) return null;
  const { id: _omit, ...rest } = cur;
  const next = { ...rest, ...patch };
  db.prepare('UPDATE flights SET data = ? WHERE id = ?').run(JSON.stringify(next), id);
  return { id, ...next };
}

function deleteFlight(id) {
  db.prepare('DELETE FROM history WHERE flight_id = ?').run(id);
  return db.prepare('DELETE FROM flights WHERE id = ?').run(id).changes > 0;
}

function addHistory(flightId, { price, googlePrice, googlePriceLevel, fliPrice, kiwiPrice, ffPrice }, checkedAt = new Date().toISOString()) {
  db.prepare(`INSERT INTO history (flight_id, price, google_price, google_level, fli_price, kiwi_price, ff_price, checked_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(flightId, price, googlePrice ?? null, googlePriceLevel ?? null, fliPrice ?? null, kiwiPrice ?? null, ffPrice ?? null, checkedAt);
}

function getHistory(flightId) {
  return db.prepare(`SELECT price, google_price AS googlePrice, google_level AS googlePriceLevel,
                            fli_price AS fliPrice, kiwi_price AS kiwiPrice, ff_price AS ffPrice, checked_at AS checkedAt
                     FROM history WHERE flight_id = ? ORDER BY checked_at ASC`).all(flightId);
}

function recentPrices(flightId, limit = 20) {
  return db.prepare('SELECT price FROM history WHERE flight_id = ? ORDER BY checked_at DESC LIMIT ?')
    .all(flightId, limit).map(r => r.price);
}

const getMeta = key => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
const setMeta = (key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

module.exports = {
  db, listFlights, getFlight, insertFlight, updateFlight, deleteFlight,
  addHistory, getHistory, recentPrices, getMeta, setMeta
};
