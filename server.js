import http from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseHash, verifyPassword } from './auth.js';
import { createBackup, pruneBackups, lastBackupAt } from './backup.js';
import { BambuError, requestCode, login as bambuLogin, recentPrints, accountUid, printers, fetchCover } from './bambu.js';
import { watchPrinters } from './bambu-live.js';
import { newVapidKeys, vapidPublicKey, readSubscription, sendPush } from './push.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// Local runs read .env themselves; in Docker the values come from the container environment.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {}

const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const SECURE_COOKIES = process.env.SECURE_COOKIES === 'true';
// Only believe X-Forwarded-For when a reverse proxy we control sets it.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_REQUESTS_PER_MINUTE = +process.env.MAX_REQUESTS_PER_MINUTE || 300;
const MAX_WRITES_PER_MINUTE = +process.env.MAX_WRITES_PER_MINUTE || 60;
const BAMBU_SYNC_MS = 5 * 60 * 1000;

if (!parseHash(ADMIN_PASSWORD_HASH)) {
  console.error('No valid owner password is configured. Run "npm run set-password" first.');
  process.exit(1);
}

// ---------- database ----------

mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'app.db');
const hadData = existsSync(DB_FILE);
// Several copies of the app can share this file (the preview environments): they wait for each
// other instead of failing when two of them write at the same moment.
const db = new DatabaseSync(DB_FILE, { timeout: 10_000 });

function backup(reason) {
  const file = createBackup(db, DATA_DIR);
  pruneBackups(DATA_DIR);
  console.log(`Backup saved (${reason}): ${path.basename(file)}`);
}
// Taken before the schema changes below, so an upgrade can always be undone.
// Refusing to start without it is deliberate: better a stopped app than unprotected data.
if (hadData) {
  try {
    backup('startup');
  } catch (e) {
    console.error(`Could not back up the database, not starting: ${e.message}`);
    process.exit(1);
  }
}
setInterval(() => {
  try {
    backup('daily');
  } catch (e) {
    console.error(`BACKUP FAILED: ${e.message}`);
  }
}, 24 * 3600 * 1000).unref();

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS spools (
    id INTEGER PRIMARY KEY,
    brand TEXT NOT NULL,
    material TEXT NOT NULL DEFAULT '',
    color_name TEXT NOT NULL DEFAULT '',
    color_hex TEXT NOT NULL DEFAULT '#888888',
    price_cents INTEGER NOT NULL,
    weight_g REAL NOT NULL,
    remaining_g REAL NOT NULL,
    code TEXT UNIQUE,
    notes TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    barcode TEXT,
    variant TEXT NOT NULL DEFAULT '',
    sealed INTEGER NOT NULL DEFAULT 0,
    empty_g REAL
  );
  -- what a product barcode stood for the last time a spool carrying it was saved
  CREATE TABLE IF NOT EXISTS products (
    barcode TEXT PRIMARY KEY,
    brand TEXT NOT NULL,
    material TEXT NOT NULL,
    color_name TEXT NOT NULL,
    color_hex TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    weight_g REAL NOT NULL,
    variant TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS wishes (
    id INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'requested',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  -- person_id is NULL for a print the owner made for themselves: stock moves, nobody is billed.
  -- A print shared between several people is stored as one print per person, each holding
  -- that person's part of the filament; group_id (the id of the first one) ties them together.
  -- billing says whether a person's part counts in what they owe: 'pending' until the owner
  -- decides, then 'billed' or 'gifted'. It means nothing on the owner's own part.
  CREATE TABLE IF NOT EXISTS prints (
    id INTEGER PRIMARY KEY,
    person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    printed_at TEXT NOT NULL,
    adjust_cents INTEGER NOT NULL DEFAULT 0,
    adjust_note TEXT NOT NULL DEFAULT '',
    wish_id INTEGER REFERENCES wishes(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    group_id INTEGER,
    billing TEXT NOT NULL DEFAULT 'billed'
  );
  -- label and cost are snapshots: they stay correct if the spool is edited or deleted later
  CREATE TABLE IF NOT EXISTS print_lines (
    id INTEGER PRIMARY KEY,
    print_id INTEGER NOT NULL REFERENCES prints(id) ON DELETE CASCADE,
    spool_id INTEGER REFERENCES spools(id) ON DELETE SET NULL,
    label TEXT NOT NULL,
    grams REAL NOT NULL,
    cost_cents INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL,
    paid_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- prints read from the Bambu Lab account, each waiting for the owner to say what it was for:
  -- pending -> billed (print_id), stock (spool_id and grams taken, nobody billed) or ignored
  CREATE TABLE IF NOT EXISTS bambu_prints (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    failed INTEGER NOT NULL DEFAULT 0,
    ended_at TEXT NOT NULL,
    material TEXT NOT NULL DEFAULT '',
    planned_g REAL NOT NULL,
    suggested_g REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    print_id INTEGER REFERENCES prints(id) ON DELETE SET NULL,
    spool_id INTEGER REFERENCES spools(id) ON DELETE SET NULL,
    grams REAL,
    color_hex TEXT NOT NULL DEFAULT ''
  );
  -- the picture of a Bambu print's model, kept as long as the print
  CREATE TABLE IF NOT EXISTS bambu_covers (
    id INTEGER PRIMARY KEY REFERENCES bambu_prints(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    data BLOB NOT NULL
  );
  -- the owner's devices that asked for notifications (Web Push, see push.js)
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

// Databases created before product barcodes existed: `code` held whatever was scanned.
// Only RFID serials ("nfc:...") are unique per spool, so everything else becomes a product barcode.
if (!db.prepare('PRAGMA table_info(spools)').all().some(c => c.name === 'barcode')) {
  db.exec(`
    ALTER TABLE spools ADD COLUMN barcode TEXT;
    UPDATE spools SET barcode = code, code = NULL WHERE code IS NOT NULL AND code NOT LIKE 'nfc:%';
    INSERT OR REPLACE INTO products (barcode, brand, material, color_name, color_hex, price_cents, weight_g)
      SELECT barcode, brand, material, color_name, color_hex, price_cents, weight_g FROM spools WHERE barcode IS NOT NULL ORDER BY id;
  `);
}
// Databases created before the filament type (silk, matte...) existed.
for (const table of ['spools', 'products']) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'variant')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN variant TEXT NOT NULL DEFAULT ''`);
  }
}
// Databases created before spools could be marked as still vacuum-sealed: every spool was opened.
if (!db.prepare('PRAGMA table_info(spools)').all().some(c => c.name === 'sealed')) {
  db.exec('ALTER TABLE spools ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0');
}
// Databases created before each spool kept the weight of its empty spool: none is known yet.
if (!db.prepare('PRAGMA table_info(spools)').all().some(c => c.name === 'empty_g')) {
  db.exec('ALTER TABLE spools ADD COLUMN empty_g REAL');
}
// Databases created before Bambu prints kept the colour of their filament: none is known.
if (!db.prepare('PRAGMA table_info(bambu_prints)').all().some(c => c.name === 'color_hex')) {
  db.exec("ALTER TABLE bambu_prints ADD COLUMN color_hex TEXT NOT NULL DEFAULT ''");
}
// Databases created before the owner could record prints for themselves: every print had to
// belong to a person. SQLite cannot relax that in place, so the table is rebuilt, and the
// rebuild is only kept if every print and every amount came through unchanged.
if (db.prepare('PRAGMA table_info(prints)').all().some(c => c.name === 'person_id' && c.notnull)) {
  const snapshot = table =>
    JSON.stringify(db.prepare(
      `SELECT p.id, p.person_id, p.title, p.printed_at, p.adjust_cents, p.adjust_note, p.wish_id, p.created_at,
              (SELECT COUNT(*) FROM print_lines l WHERE l.print_id = p.id) AS line_count,
              (SELECT COALESCE(SUM(l.cost_cents), 0) FROM print_lines l WHERE l.print_id = p.id) AS cost_cents,
              (SELECT COUNT(*) FROM bambu_prints b WHERE b.print_id = p.id) AS bambu_count
       FROM ${table} p ORDER BY p.id`
    ).all());
  // With foreign keys on, dropping the old table would also delete the lines of every print.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    const before = snapshot('prints');
    db.exec(`
      CREATE TABLE prints_new (
        id INTEGER PRIMARY KEY,
        person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        printed_at TEXT NOT NULL,
        adjust_cents INTEGER NOT NULL DEFAULT 0,
        adjust_note TEXT NOT NULL DEFAULT '',
        wish_id INTEGER REFERENCES wishes(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO prints_new (id, person_id, title, printed_at, adjust_cents, adjust_note, wish_id, created_at)
        SELECT id, person_id, title, printed_at, adjust_cents, adjust_note, wish_id, created_at FROM prints;
      DROP TABLE prints;
      ALTER TABLE prints_new RENAME TO prints;
    `);
    if (snapshot('prints') !== before) throw new Error('prints changed during the conversion');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('broken links after the conversion');
    db.exec('COMMIT');
    console.log('Database upgraded: a print can now belong to the owner.');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(`Could not upgrade the prints table, not starting: ${e.message}`);
    process.exit(1);
  }
  db.exec('PRAGMA foreign_keys = ON');
}
// Databases created before a print could be shared between several people.
if (!db.prepare('PRAGMA table_info(prints)').all().some(c => c.name === 'group_id')) {
  db.exec('ALTER TABLE prints ADD COLUMN group_id INTEGER');
}
// What a person owes: their billed prints, less their payments. A print waiting for the
// owner's decision, or gifted, is left out.
const printsSum = billing => `
  COALESCE((SELECT SUM(l.cost_cents) FROM print_lines l JOIN prints p ON p.id = l.print_id WHERE p.person_id = pe.id AND p.billing = '${billing}'), 0)
  + COALESCE((SELECT SUM(adjust_cents) FROM prints WHERE person_id = pe.id AND billing = '${billing}'), 0)`;
const BALANCE_SQL = `${printsSum('billed')}
  - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE person_id = pe.id), 0)`;
const BILLING = ['pending', 'billed', 'gifted'];

// Databases created before a print could be assigned without being billed: every print
// recorded until then was billed, so it stays billed and every balance stays the same.
if (!db.prepare('PRAGMA table_info(prints)').all().some(c => c.name === 'billing')) {
  const balances = () => JSON.stringify(db.prepare(`SELECT pe.id, ${BALANCE_SQL} AS b FROM people pe ORDER BY pe.id`).all());
  db.exec('BEGIN');
  try {
    const before = JSON.stringify(db.prepare(
      `SELECT pe.id,
         COALESCE((SELECT SUM(l.cost_cents) FROM print_lines l JOIN prints p ON p.id = l.print_id WHERE p.person_id = pe.id), 0)
         + COALESCE((SELECT SUM(adjust_cents) FROM prints WHERE person_id = pe.id), 0)
         - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE person_id = pe.id), 0) AS b
       FROM people pe ORDER BY pe.id`
    ).all());
    db.exec("ALTER TABLE prints ADD COLUMN billing TEXT NOT NULL DEFAULT 'billed'");
    if (balances() !== before) throw new Error('amounts due changed during the conversion');
    db.exec('COMMIT');
    console.log('Database upgraded: a print can now be assigned to a person before deciding to bill it.');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(`Could not upgrade the prints table, not starting: ${e.message}`);
    process.exit(1);
  }
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = msg => new HttpError(400, msg);

function str(v, max, name) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length > max) throw bad(name ? `Champ « ${name} » trop long` : 'Texte trop long');
  if (name && !s) throw bad(`Champ « ${name} » obligatoire`);
  return s;
}
function num(v, min, max, name) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw bad(`Champ « ${name} » invalide`);
  return n;
}
const int = (v, min, max, name) => Math.round(num(v, min, max, name));
const day = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : new Date().toISOString().slice(0, 10));
const newToken = () => randomBytes(24).toString('base64url');

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function isAdmin(req) {
  const sid = cookies(req).sid;
  if (!sid) return false;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(sid);
  return !!row && row.expires_at > Date.now();
}
function guestOf(req) {
  const token = req.headers['x-invite'];
  if (typeof token !== 'string' || !token) return null;
  return db.prepare('SELECT id, name FROM people WHERE token = ?').get(token) || null;
}
function sessionCookie(value, maxAgeSec) {
  return `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE_COOKIES ? '; Secure' : ''}`;
}

function clientKey(req) {
  const fwd = TRUST_PROXY && req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',').pop().trim()) || req.socket.remoteAddress || '?';
}

// Request limiters, per client address: one for everything, a stricter one for changes.
function limiter(maxPerMinute) {
  const windows = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, w] of windows) if (w.reset < now) windows.delete(key);
  }, 60_000).unref();
  return key => {
    const now = Date.now();
    let w = windows.get(key);
    if (!w || w.reset < now) windows.set(key, (w = { count: 0, reset: now + 60_000 }));
    return ++w.count > maxPerMinute;
  };
}
const tooManyRequests = limiter(MAX_REQUESTS_PER_MINUTE);
const tooManyWrites = limiter(MAX_WRITES_PER_MINUTE);

// Failed-login limiter, per client address.
const failures = new Map();
function loginBlocked(key) {
  const f = failures.get(key);
  if (f && f.until < Date.now()) failures.delete(key);
  return (failures.get(key)?.count || 0) >= 10;
}
function loginFailed(key) {
  const f = failures.get(key) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
  f.count++;
  failures.set(key, f);
}

// ---------- queries ----------


// `guestId` limits the list to one person's prints and leaves out who else shares them:
// a guest learns that a print is shared, never with whom. A print the owner has not yet
// decided to bill or gift stays out of the guest's sight.
function listPrints(guestId) {
  const prints = db.prepare(
    `SELECT p.id, p.person_id, pe.name AS person_name, p.title, p.printed_at, p.adjust_cents, p.adjust_note, p.group_id, p.billing
     FROM prints p LEFT JOIN people pe ON pe.id = p.person_id ${guestId ? "WHERE p.person_id = ? AND p.billing != 'pending'" : ''}
     ORDER BY p.printed_at DESC, p.id DESC`
  ).all(...(guestId ? [guestId] : []));
  const others = db.prepare(
    'SELECT pe.name FROM prints g LEFT JOIN people pe ON pe.id = g.person_id WHERE g.group_id = ? AND g.id != ? ORDER BY g.id'
  );
  // color_hex is only there to draw a colour dot; it is null once the spool is deleted.
  const lines = db.prepare(
    `SELECT l.label, l.grams, l.cost_cents, s.color_hex
     FROM print_lines l LEFT JOIN spools s ON s.id = l.spool_id WHERE l.print_id = ? ORDER BY l.id`
  );
  for (const p of prints) {
    p.lines = lines.all(p.id);
    p.total_cents = p.lines.reduce((sum, l) => sum + l.cost_cents, 0) + p.adjust_cents;
    const shared = p.group_id ? others.all(p.group_id, p.id) : [];
    p.share_count = shared.length + 1;
    // a null name is the owner's own part
    if (!guestId) {
      p.shared_with = shared.map(o => o.name);
      p.edit = printSnapshot(p.id).form;
    }
    delete p.group_id;
  }
  return prints;
}

function spoolInput(b) {
  const weight = num(b.weight_g, 1, 100000, 'Poids');
  return [
    str(b.brand, 80, 'Marque'),
    str(b.material, 40),
    str(b.color_name, 60),
    /^#[0-9a-f]{6}$/i.test(b.color_hex) ? b.color_hex : '#888888',
    int(b.price_cents, 0, 10000000, 'Prix'),
    weight,
    b.remaining_g == null || b.remaining_g === '' ? weight : num(b.remaining_g, -100000, 100000, 'Restant'),
    str(b.code, 500) || null,
    str(b.notes, 1000),
    b.archived ? 1 : 0,
    str(b.barcode, 500) || null,
    str(b.variant, 40),
    b.sealed ? 1 : 0,
    b.empty_g == null || b.empty_g === '' ? null : num(b.empty_g, 0, 5000, 'Poids de la bobine vide'),
  ];
}
function saveSpool(values, fn) {
  let result;
  try {
    result = fn();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Une autre bobine utilise déjà ce tag RFID');
    throw e;
  }
  const [brand, material, colorName, colorHex, price, weight] = values;
  const [barcode, variant] = values.slice(10, 12);
  if (barcode) {
    db.prepare(
      'INSERT OR REPLACE INTO products (barcode, brand, material, color_name, color_hex, price_cents, weight_g, variant) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(barcode, brand, material, colorName, colorHex, price, weight, variant);
  }
  return result;
}
function mustExist(table, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, 'Introuvable');
  return row;
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

const spoolLabel = spool => [spool.brand, spool.material, spool.variant, spool.color_name].filter(Boolean).join(' ');
const spoolCost = (spool, grams) => Math.round((grams * spool.price_cents) / spool.weight_g);
// lines of a print are told apart by spool, or by label once the spool is deleted
const lineKey = (spoolId, label) => (spoolId ? `s${spoolId}` : `l${label}`);

// The cost of a line in an edited print, for filament the print already used. Costs are
// frozen when a print is recorded, so a later change of the spool's price must not show up:
// - same grams split the same way: the exact cost billed before;
// - the spool's price has not changed: the usual sum;
// - otherwise: the price per gram the print was billed at.
function lineCost(kept, spool, grams, parts) {
  const same = kept.lines.length === kept.parts && kept.parts === parts &&
    kept.lines.every(l => Math.abs(l.grams - grams) < 1e-9 && l.cost_cents === kept.lines[0].cost_cents);
  if (same) return kept.lines[0].cost_cents;
  if (spool && kept.lines.every(l => spoolCost(spool, l.grams) === l.cost_cents)) return spoolCost(spool, grams);
  return kept.grams > 0 ? Math.round((grams * kept.cost_cents) / kept.grams) : 0;
}

// Everything about a print (all its parts when shared) needed to show it in the edit form
// and to keep its billed costs: who it is for, and its filament summed over every part.
function printSnapshot(id) {
  const groupId = mustExist('prints', id).group_id;
  const prints = groupId
    ? db.prepare('SELECT * FROM prints WHERE group_id = ? ORDER BY id').all(groupId)
    : db.prepare('SELECT * FROM prints WHERE id = ?').all(id);
  const lines = new Map();
  for (const p of prints) {
    for (const l of db.prepare('SELECT * FROM print_lines WHERE print_id = ? ORDER BY id').all(p.id)) {
      const key = lineKey(l.spool_id, l.label);
      const kept = lines.get(key) || { spool_id: l.spool_id, label: l.label, grams: 0, cost_cents: 0, parts: prints.length, lines: [] };
      kept.grams += l.grams;
      kept.cost_cents += l.cost_cents;
      kept.lines.push(l);
      lines.set(key, kept);
    }
  }
  // the adjustment was split between every part, the owner's included, which pays nothing
  const billedPart = prints.find(p => p.person_id !== null);
  return {
    prints,
    lines,
    form: {
      person_ids: prints.map(p => p.person_id),
      title: prints[0].title,
      printed_at: prints[0].printed_at,
      adjust_cents: billedPart ? billedPart.adjust_cents * prints.length : 0,
      adjust_note: billedPart?.adjust_note || '',
      // a failed print read from the Bambu account stays the owner's own: nobody is billed for it
      failed: prints.some(p => db.prepare('SELECT 1 FROM bambu_prints WHERE print_id = ? AND failed = 1').get(p.id)),
      lines: [...lines.values()].map(l => ({ spool_id: l.spool_id, label: l.label, grams: Math.round(l.grams * 100) / 100, cost_cents: l.cost_cents })),
    },
  };
}

// Must run inside tx(): deletes a print with every part of it, giving its filament back.
// Returns the ids of the Bambu Lab prints it was billed from.
function removePrint(snapshot) {
  const bambuIds = [];
  for (const p of snapshot.prints) {
    // give the filament back to the spools that still exist
    for (const l of db.prepare('SELECT spool_id, grams FROM print_lines WHERE print_id = ? AND spool_id IS NOT NULL').all(p.id)) {
      db.prepare('UPDATE spools SET remaining_g = remaining_g + ? WHERE id = ?').run(l.grams, l.spool_id);
    }
    bambuIds.push(...db.prepare('SELECT id FROM bambu_prints WHERE print_id = ?').all(p.id).map(r => r.id));
    db.prepare('DELETE FROM prints WHERE id = ?').run(p.id);
  }
  return bambuIds;
}

// Must run inside tx(): an edited print is recorded again from scratch, keeping what ties it
// to the rest: its Bambu Lab print, the wish it answered, when it was first recorded, and
// whether each person's part is billed. A person added to it waits for the owner's decision.
function editPrint(id, body) {
  const before = printSnapshot(id);
  if (before.form.failed) ownerOnly(body);
  const bambuIds = removePrint(before);
  const { id: newId } = createPrint({ ...body, wish_id: null }, before.lines);
  const created = db.prepare('SELECT id, person_id FROM prints WHERE id = ? OR group_id = ?').all(newId, newId);
  for (const p of created) {
    const kept = before.prints.find(o => o.person_id !== null && o.person_id === p.person_id);
    db.prepare('UPDATE prints SET wish_id = ?, created_at = ?, billing = ? WHERE id = ?')
      .run(kept?.wish_id ?? null, before.prints[0].created_at, kept?.billing ?? (p.person_id === null ? 'billed' : 'pending'), p.id);
  }
  for (const b of bambuIds) db.prepare("UPDATE bambu_prints SET state = 'billed', print_id = ? WHERE id = ?").run(newId, b);
  return { id: newId };
}

// Must run inside tx(): takes a print's filament out of the spools and assigns it.
// `person_ids` lists who it is for; null stands for the owner, whose part is billed to nobody.
// A person's part counts in what they owe only once the owner bills it (see /billing).
// Several people share a print in equal parts: each gets a print of their own holding their
// part of the filament and of the adjustment, so every amount is computed as for any print.
// `previous` is only given when a print is edited: the filament it already used keeps the
// cost it was billed at (see printSnapshot).
function createPrint(body, previous = null) {
  const asked = Array.isArray(body.person_ids) ? body.person_ids.slice(0, 50) : [body.person_id];
  const ids = [...new Set(asked.map(v => {
    if (v === undefined) throw bad('Choisissez une personne');
    return v === null ? null : int(v, 1, Number.MAX_SAFE_INTEGER, 'Personne');
  }))];
  if (!ids.length) throw bad('Choisissez une personne');
  const people = ids.map(id => (id === null ? null : mustExist('people', id)));
  const parts = people.length;
  const title = str(body.title, 120, 'Titre');
  const printedAt = day(body.printed_at);
  // an adjustment is a billing matter: it means nothing on a part nobody pays for
  const billed = people.some(Boolean);
  const adjust = billed && body.adjust_cents ? int(body.adjust_cents, -10000000, 10000000, 'Ajustement') : 0;
  const note = str(body.adjust_note, 200);
  const lines = (Array.isArray(body.lines) ? body.lines.slice(0, 32) : []).map(line => {
    const grams = num(line?.grams, 0.01, 100000, 'Grammes') / parts;
    // a line kept from the print being edited whose spool was deleted since: no stock to move
    if (line.spool_id == null && previous) {
      const kept = previous.get(lineKey(null, line.label));
      if (!kept) throw bad('Choisissez une bobine');
      return { spool: null, label: kept.label, grams, cost: lineCost(kept, null, grams, parts) };
    }
    const spool = mustExist('spools', int(line.spool_id, 1, Number.MAX_SAFE_INTEGER, 'Bobine'));
    const label = spoolLabel(spool);
    const kept = previous?.get(lineKey(spool.id));
    return { spool, label, grams, cost: kept ? lineCost(kept, spool, grams, parts) : spoolCost(spool, grams) };
  });
  if (!lines.length && !adjust) throw bad(billed ? 'Ajoutez au moins un filament ou un ajustement' : 'Ajoutez au moins un filament');

  let firstId = null;
  let groupId = null;
  for (const person of people) {
    let wishId = null;
    if (person && body.wish_id) {
      const wish = db.prepare('SELECT id FROM wishes WHERE id = ? AND person_id = ?').get(Number(body.wish_id) || 0, person.id);
      if (wish) {
        wishId = wish.id;
        db.prepare("UPDATE wishes SET status = 'printed' WHERE id = ?").run(wishId);
      }
    }
    const id = db.prepare(
      'INSERT INTO prints (person_id, title, printed_at, adjust_cents, adjust_note, wish_id, group_id, billing) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(person?.id ?? null, title, printedAt, person ? Math.round(adjust / parts) : 0, person ? note : '', wishId, groupId, person ? 'pending' : 'billed').lastInsertRowid;
    if (parts > 1 && groupId === null) {
      groupId = id;
      db.prepare('UPDATE prints SET group_id = ? WHERE id = ?').run(groupId, id);
    }
    for (const { spool, label, grams, cost } of lines) {
      db.prepare('INSERT INTO print_lines (print_id, spool_id, label, grams, cost_cents) VALUES (?, ?, ?, ?, ?)').run(id, spool?.id ?? null, label, grams, cost);
      if (!spool) continue;
      // no floor at 0: what is taken here is exactly what is given back if the print is
      // deleted or edited, and a spool below 0 shows that its weight needs checking
      db.prepare('UPDATE spools SET remaining_g = remaining_g - ?, sealed = 0 WHERE id = ?').run(grams, spool.id);
      setSetting('last_spool_id', spool.id);
    }
    firstId ??= id;
  }
  return { id: firstId };
}

// ---------- Bambu Lab account ----------

// The access key stays in the database: only this summary ever reaches the browser.
function bambuStatus() {
  const b = getSetting('bambu');
  return b ? { connected: true, last_sync: b.lastSync || null, error: b.error || null, live: live.status } : { connected: false };
}

let bambuSyncing = null;
const coverTried = new Set();
// Files the prints that ended since the account was connected, to be assigned by the owner.
function syncBambu() {
  bambuSyncing ??= (async () => {
    const account = getSetting('bambu');
    if (!account) return;
    let error = null;
    const added = [];
    const listed = [];
    try {
      const add = db.prepare(
        'INSERT OR IGNORE INTO bambu_prints (id, title, failed, ended_at, material, planned_g, suggested_g, color_hex) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const p of await recentPrints(account.token)) {
        if (p.endedAt < account.since) continue;
        if (add.run(p.id, p.title, p.failed ? 1 : 0, p.endedAt, p.material, p.plannedGrams, p.suggestedGrams, p.color).changes) added.push(p);
        listed.push(p);
      }
    } catch (e) {
      if (!(e instanceof BambuError)) throw e;
      error = e.reason;
    }
    // The owner may have disconnected or signed in again while Bambu was answering.
    const current = getSetting('bambu');
    if (current?.token !== account.token) return;
    setSetting('bambu', { ...current, error, lastSync: error ? current.lastSync : new Date().toISOString() });
    if (added.length) notifyNewPrints(added);
    // Every print Bambu still lists gets its picture, also those filed before pictures were kept.
    // A print whose picture could not be had is tried once per start, not at every reading.
    const hasCover = db.prepare('SELECT 1 FROM bambu_covers WHERE id = ?');
    const known = db.prepare('SELECT 1 FROM bambu_prints WHERE id = ?');
    for (const p of listed) {
      if (!p.cover || coverTried.has(p.id) || hasCover.get(p.id)) continue;
      coverTried.add(p.id);
      const cover = await fetchCover(p.cover);
      // the print may have been removed while the picture was downloading
      if (cover && known.get(p.id)) db.prepare('INSERT OR IGNORE INTO bambu_covers (id, type, data) VALUES (?, ?, ?)').run(p.id, cover.type, cover.data);
    }
  })().finally(() => {
    bambuSyncing = null;
  });
  return bambuSyncing;
}
const syncBambuQuietly = () => syncBambu().catch(e => console.error(`Bambu sync failed: ${e.message}`));
// When several copies of the app share one database (the preview environments), only one of them
// reads the account per period: the unofficial interface is not called more often than by one app.
function claimBambuSync() {
  const now = Date.now();
  return (
    db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('bambu_sync_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(value AS INTEGER) <= ?`
      )
      .run(String(now), now - BAMBU_SYNC_MS + 30_000).changes > 0
  );
}
const syncBambuOnSchedule = () => claimBambuSync() && syncBambuQuietly();
setInterval(syncBambuOnSchedule, BAMBU_SYNC_MS).unref();
syncBambuOnSchedule();

// ---------- live printer status ----------

// What each printer reported last, merged: printers send only what changed since their last report.
const printerStates = new Map();
let live = { stop: () => {}, status: 'off' };
const BUSY = new Set(['PREPARE', 'SLICING', 'RUNNING', 'PAUSE']);
const STALE_MS = 30 * 60 * 1000;

// Listens to the account's printers while it is connected; called again whenever that changes.
async function startLive() {
  live.stop();
  printerStates.clear();
  const account = getSetting('bambu');
  if (!account) return (live = { stop: () => {}, status: 'off' });
  const current = (live = { stop: () => {}, status: 'off' });
  let timer = null;
  current.stop = () => clearTimeout(timer);
  try {
    const [uid, list] = await Promise.all([accountUid(account.token), printers(account.token)]);
    if (live !== current) return;
    for (const p of list) printerStates.set(p.id, { name: p.name, updated: 0 });
    current.stop = watchPrinters({
      uid,
      token: account.token,
      printerIds: list.map(p => p.id),
      onReport,
      onStatus: status => (current.status = status),
    });
  } catch (e) {
    if (!(e instanceof BambuError)) console.error(`Bambu live status failed: ${e.message}`);
    if (live !== current) return;
    current.status = e.reason === 'unreachable' ? 'off' : 'refused';
    // tried again later, without insisting on an account Bambu turned down
    timer = setTimeout(startLive, e.reason === 'unreachable' ? 5 * 60_000 : 30 * 60_000);
    timer.unref();
  }
}

function onReport(id, message) {
  const p = message.print;
  const printer = printerStates.get(id);
  if (!printer || !p || typeof p !== 'object') return;
  const before = printer.state;
  if (typeof p.gcode_state === 'string') printer.state = p.gcode_state.slice(0, 20);
  if (typeof p.subtask_name === 'string') printer.title = p.subtask_name.slice(0, 120);
  for (const [key, field] of [['mc_percent', 'percent'], ['mc_remaining_time', 'remaining'], ['layer_num', 'layer'], ['total_layer_num', 'layers'], ['print_error', 'error']]) {
    if (Number.isSafeInteger(p[key]) && p[key] >= 0) printer[field] = p[key];
  }
  printer.updated = Date.now();
  // A print just ended: Bambu files it in the account history a little later, so look a few times.
  if (BUSY.has(before) && (printer.state === 'FINISH' || printer.state === 'FAILED')) {
    for (const delay of [15_000, 60_000, 180_000]) setTimeout(syncBambuQuietly, delay).unref();
  }
  // The printer stopped itself on a problem: tell the owner once per problem.
  if (printer.state === 'PAUSE' && printer.error && printer.alerted !== printer.error) {
    printer.alerted = printer.error;
    const code = printer.error.toString(16).toUpperCase().padStart(8, '0');
    notifyOwner({
      title: `${printer.title || printer.name} : en pause`,
      body: `L’imprimante signale un problème (code ${code.slice(0, 4)}-${code.slice(4)}).`,
      url: '/',
      tag: `bambu-error-${id}`,
    });
  }
  if (printer.state === 'RUNNING') printer.alerted = 0;
}

// The printers busy printing, for the owner's screen.
const livePrinters = () =>
  [...printerStates.values()]
    .filter(p => BUSY.has(p.state) && Date.now() - p.updated < STALE_MS)
    .map(p => ({
      name: p.name,
      title: p.title || '',
      state: p.state,
      percent: p.percent ?? null,
      remaining_min: p.remaining ?? null,
      layer: p.layer ?? null,
      layers: p.layers ?? null,
      error: p.state === 'PAUSE' && p.error ? p.error.toString(16).toUpperCase().padStart(8, '0') : null,
    }));

// ---------- notifications ----------

// The server's own key pair for Web Push, made once. Only its public half leaves the server.
function vapidKeys() {
  let keys = getSetting('vapid');
  if (!keys) setSetting('vapid', (keys = newVapidKeys()));
  return keys;
}

// Sends a notification to every device of the owner that asked for them, forgetting the
// devices whose browser dropped the subscription. Never fails: a notification is a bonus.
async function notifyOwner(message) {
  let sent = 0;
  try {
    const subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all();
    const contact = getSetting('push_contact') || 'mailto:owner@localhost';
    await Promise.all(subs.map(async sub => {
      const result = await sendPush(sub, message, vapidKeys(), contact);
      if (result === 'gone') db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
      if (result === 'sent') sent++;
      if (result === 'failed') console.error(`Notification not delivered to ${new URL(sub.endpoint).hostname}`);
    }));
  } catch (e) {
    console.error(`Notification failed: ${e.message}`);
  }
  return sent;
}

const fmtGrams = g => g.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
function notifyNewPrints(prints) {
  // a pile of prints at once (the first reading, or after an outage) makes one notification
  if (prints.length > 3) {
    return notifyOwner({ title: `${prints.length} impressions à attribuer`, body: 'Ouvrez l’onglet Impressions pour les attribuer.', url: '/#bambu', tag: 'bambu-many' });
  }
  for (const p of prints) {
    notifyOwner({
      title: `${p.title} : ${p.failed ? 'ratée' : 'terminée'}`,
      body: `${[p.material, `${fmtGrams(p.suggestedGrams)} g`].filter(Boolean).join(' · ')}. Appuyez pour l’attribuer.`,
      url: `/#bambu=${p.id}`,
      tag: `bambu-${p.id}`,
    });
  }
}

function bambuHttpError(e) {
  if (!(e instanceof BambuError)) return e;
  return new HttpError(502, e.reason === 'unreachable' ? 'Bambu Lab est injoignable, réessayez plus tard' : 'Bambu Lab a refusé : vérifiez l’adresse e-mail et le code');
}
// A failed print is never billed: it can only be the owner's own.
function ownerOnly(body) {
  if (!Array.isArray(body.person_ids) || body.person_ids.some(v => v !== null)) throw bad('Une impression ratée n’est facturée à personne');
}

function pendingBambuPrint(id) {
  const row = mustExist('bambu_prints', id);
  if (row.state !== 'pending') throw new HttpError(409, 'Cette impression a déjà été traitée');
  return row;
}

// ---------- routes ----------

const routes = [];
function route(method, pattern, role, fn) {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>\\d+)') + '$');
  routes.push({ method, re, role, fn });
}

route('POST', '/api/login', 'public', async ({ req, res, body }) => {
  const key = clientKey(req);
  if (loginBlocked(key)) throw new HttpError(429, 'Trop de tentatives, réessayez plus tard');
  const password = typeof body.password === 'string' ? body.password.slice(0, 1000) : '';
  if (!(await verifyPassword(password, ADMIN_PASSWORD_HASH))) {
    loginFailed(key);
    throw new HttpError(401, 'Mot de passe incorrect');
  }
  failures.delete(key);
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(token, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_MS / 1000));
  return { ok: true };
});

route('POST', '/api/logout', 'public', ({ req, res }) => {
  const sid = cookies(req).sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(sid);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
});

route('GET', '/api/state', 'admin', () => ({
  last_backup: lastBackupAt(DATA_DIR),
  bambu: bambuStatus(),
  bambu_prints: db.prepare(
    `SELECT id, title, failed, ended_at, material, planned_g, suggested_g, state, spool_id, grams, color_hex,
            EXISTS (SELECT 1 FROM bambu_covers c WHERE c.id = b.id) AS has_cover
     FROM bambu_prints b WHERE state != 'billed' ORDER BY state = 'pending' DESC, ended_at DESC LIMIT 200`
  ).all(),
  bambu_live: livePrinters(),
  last_spool_id: getSetting('last_spool_id'),
  empty_spool_g: getSetting('empty_spool_g') ?? 0,
  spools: db.prepare('SELECT * FROM spools ORDER BY archived, sealed, brand COLLATE NOCASE, material, variant, color_name').all(),
  products: db.prepare('SELECT * FROM products').all(),
  people: db.prepare(
    `SELECT pe.id, pe.name, pe.token, ${BALANCE_SQL} AS balance_cents FROM people pe ORDER BY pe.name COLLATE NOCASE`
  ).all(),
  prints: listPrints(),
  payments: db.prepare('SELECT * FROM payments ORDER BY paid_at DESC, id DESC').all(),
  wishes: db.prepare(
    'SELECT w.*, pe.name AS person_name FROM wishes w JOIN people pe ON pe.id = w.person_id ORDER BY w.id DESC'
  ).all(),
}));

route('POST', '/api/spools', 'admin', ({ body }) => {
  const values = spoolInput(body);
  return saveSpool(values, () => ({
    id: db.prepare(
      `INSERT INTO spools (brand, material, color_name, color_hex, price_cents, weight_g, remaining_g, code, notes, archived, barcode, variant, sealed, empty_g)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...values).lastInsertRowid,
  }));
});
route('PUT', '/api/spools/:id', 'admin', ({ params, body }) => {
  mustExist('spools', params.id);
  const values = spoolInput(body);
  saveSpool(values, () =>
    db.prepare(
      `UPDATE spools SET brand = ?, material = ?, color_name = ?, color_hex = ?, price_cents = ?, weight_g = ?,
       remaining_g = ?, code = ?, notes = ?, archived = ?, barcode = ?, variant = ?, sealed = ?, empty_g = ? WHERE id = ?`
    ).run(...values, params.id)
  );
  return { ok: true };
});
route('DELETE', '/api/spools/:id', 'admin', ({ params }) => {
  db.prepare('DELETE FROM spools WHERE id = ?').run(params.id);
  return { ok: true };
});

// The weight of an empty spool offered by default to a new spool, which can keep its own.
route('PUT', '/api/settings', 'admin', ({ body }) => {
  setSetting('empty_spool_g', Math.round(num(body.empty_spool_g, 0, 5000, 'Poids de la bobine vide') * 100) / 100);
  return { ok: true };
});

route('POST', '/api/people', 'admin', ({ body }) => ({
  id: db.prepare('INSERT INTO people (name, token) VALUES (?, ?)').run(str(body.name, 60, 'Nom'), newToken()).lastInsertRowid,
}));
route('POST', '/api/people/:id/token', 'admin', ({ params }) => {
  mustExist('people', params.id);
  db.prepare('UPDATE people SET token = ? WHERE id = ?').run(newToken(), params.id);
  return { ok: true };
});
route('DELETE', '/api/people/:id', 'admin', ({ params }) => {
  db.prepare('DELETE FROM people WHERE id = ?').run(params.id);
  return { ok: true };
});

route('POST', '/api/prints', 'admin', ({ body }) => tx(() => createPrint(body)));
route('PUT', '/api/prints/:id', 'admin', ({ params, body }) => tx(() => editPrint(params.id, body)));
// Bills a person's part of a print, gifts it, or puts it back to decide later. Each part of
// a shared print is decided on its own.
route('PUT', '/api/prints/:id/billing', 'admin', ({ params, body }) => {
  if (!BILLING.includes(body.billing)) throw bad('Facturation invalide');
  if (mustExist('prints', params.id).person_id === null) throw bad('Vos propres impressions ne sont facturées à personne');
  db.prepare('UPDATE prints SET billing = ? WHERE id = ?').run(body.billing, params.id);
  return { ok: true };
});
route('DELETE', '/api/prints/:id', 'admin', ({ params }) =>
  tx(() => {
    // a shared print goes as a whole: every person's part with it
    const bambuIds = removePrint(printSnapshot(params.id));
    // a print that came from the Bambu account goes back to the ones waiting to be assigned
    for (const b of bambuIds) db.prepare("UPDATE bambu_prints SET state = 'pending', print_id = NULL WHERE id = ?").run(b);
    return { ok: true };
  })
);

route('POST', '/api/bambu/code', 'admin', async ({ body }) => {
  await requestCode(str(body.email, 200, 'E-mail')).catch(e => {
    throw bambuHttpError(e);
  });
  return { ok: true };
});
route('POST', '/api/bambu/login', 'admin', async ({ body }) => {
  const email = str(body.email, 200, 'E-mail');
  const code = str(body.code, 12, 'Code');
  const { token, expiresAt } = await bambuLogin(email, code).catch(e => {
    throw bambuHttpError(e);
  });
  // Only prints that end from now on are picked up: the older history is left alone.
  setSetting('bambu', { token, expiresAt, since: getSetting('bambu')?.since || new Date().toISOString() });
  await syncBambu();
  startLive();
  return { ok: true };
});
route('DELETE', '/api/bambu', 'admin', () => {
  db.prepare("DELETE FROM settings WHERE key = 'bambu'").run();
  startLive();
  return { ok: true };
});
// What the printers are doing now, and how many prints wait: the owner's screen asks every few seconds.
route('GET', '/api/bambu/live', 'admin', () => ({
  live: livePrinters(),
  pending: db.prepare("SELECT COUNT(*) AS n FROM bambu_prints WHERE state = 'pending'").get().n,
}));
route('GET', '/api/bambu/prints/:id/cover', 'admin', ({ params, res }) => {
  const cover = db.prepare('SELECT type, data FROM bambu_covers WHERE id = ?').get(params.id);
  if (!cover) throw new HttpError(404, 'Introuvable');
  // the picture of a print never changes
  res.writeHead(200, { 'Content-Type': cover.type, 'Cache-Control': 'private, max-age=2592000, immutable' });
  res.end(cover.data);
});

// Notifications reach the owner's devices only: a guest page has no way to ask for them.
route('GET', '/api/push/key', 'admin', () => ({ key: vapidPublicKey(vapidKeys()) }));
route('POST', '/api/push/subscriptions', 'admin', ({ req, body }) => {
  const sub = readSubscription(body);
  if (!sub) throw bad('Cet appareil ne peut pas recevoir de notifications');
  if (db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n >= 20) throw bad('Trop d’appareils : désactivez-en un d’abord');
  db.prepare('INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)').run(sub.endpoint, sub.p256dh, sub.auth);
  // Push services want a way to reach whoever sends: the address of this site.
  const origin = /^https:\/\/[\w.-]+(:\d+)?$/.exec(req.headers.origin || '')?.[0];
  if (origin) setSetting('push_contact', origin);
  return { ok: true };
});
route('DELETE', '/api/push/subscriptions', 'admin', ({ body }) => {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(body.endpoint || ''));
  return { ok: true };
});
route('POST', '/api/push/test', 'admin', async () => {
  const sent = await notifyOwner({ title: 'Notifications activées', body: 'Vous serez prévenu à la fin de chaque impression.', url: '/', tag: 'test' });
  if (!sent) throw new HttpError(502, 'La notification n’a pas pu être envoyée');
  return { sent };
});
route('POST', '/api/bambu/sync', 'admin', async () => {
  await syncBambu();
  return bambuStatus();
});
route('POST', '/api/bambu/prints/:id/bill', 'admin', ({ params, body }) =>
  tx(() => {
    if (pendingBambuPrint(params.id).failed) ownerOnly(body);
    const { id } = createPrint(body);
    db.prepare("UPDATE bambu_prints SET state = 'billed', print_id = ? WHERE id = ?").run(id, params.id);
    return { id };
  })
);
route('POST', '/api/bambu/prints/:id/ignore', 'admin', ({ params }) => {
  pendingBambuPrint(params.id);
  db.prepare("UPDATE bambu_prints SET state = 'ignored' WHERE id = ?").run(params.id);
  return { ok: true };
});
// Undo "ignore", or "stock" (an option since removed, which only took filament from a spool):
// the filament goes back to its spool and the print waits again.
route('POST', '/api/bambu/prints/:id/reset', 'admin', ({ params }) =>
  tx(() => {
    const row = mustExist('bambu_prints', params.id);
    if (row.state !== 'stock' && row.state !== 'ignored') throw new HttpError(409, 'Cette impression ne peut pas être remise à attribuer');
    if (row.state === 'stock' && row.spool_id) {
      db.prepare('UPDATE spools SET remaining_g = remaining_g + ? WHERE id = ?').run(row.grams, row.spool_id);
    }
    db.prepare("UPDATE bambu_prints SET state = 'pending', spool_id = NULL, grams = NULL WHERE id = ?").run(params.id);
    return { ok: true };
  })
);

route('POST', '/api/payments', 'admin', ({ body }) => {
  const person = mustExist('people', int(body.person_id, 1, Number.MAX_SAFE_INTEGER, 'Personne'));
  return {
    id: db.prepare('INSERT INTO payments (person_id, amount_cents, paid_at, note) VALUES (?, ?, ?, ?)').run(
      person.id, int(body.amount_cents, 1, 10000000, 'Montant'), day(body.paid_at), str(body.note, 200)
    ).lastInsertRowid,
  };
});
route('DELETE', '/api/payments/:id', 'admin', ({ params }) => {
  db.prepare('DELETE FROM payments WHERE id = ?').run(params.id);
  return { ok: true };
});

function addWish(personId, body, status) {
  const url = str(body.url, 500);
  if (url && !/^https?:\/\//i.test(url)) throw bad('Le lien doit commencer par http:// ou https://');
  return db.prepare('INSERT INTO wishes (person_id, title, url, note, status) VALUES (?, ?, ?, ?, ?)').run(
    personId, str(body.title, 120, 'Titre'), url, str(body.note, 500), status
  ).lastInsertRowid;
}

// A wish the owner adds for someone is already accepted: they chose to print it.
route('POST', '/api/wishes', 'admin', ({ body }) => {
  const person = mustExist('people', int(body.person_id, 1, Number.MAX_SAFE_INTEGER, 'Personne'));
  return { id: addWish(person.id, body, 'accepted') };
});
route('PUT', '/api/wishes/:id', 'admin', ({ params, body }) => {
  if (!['requested', 'accepted', 'printed', 'declined'].includes(body.status)) throw bad('Statut invalide');
  mustExist('wishes', params.id);
  db.prepare('UPDATE wishes SET status = ? WHERE id = ?').run(body.status, params.id);
  return { ok: true };
});
route('DELETE', '/api/wishes/:id', 'admin', ({ params }) => {
  db.prepare('DELETE FROM wishes WHERE id = ?').run(params.id);
  return { ok: true };
});

// Guest area: everything is scoped to the person behind the invite link.
route('GET', '/api/my', 'guest', ({ person }) => ({
  person: { name: person.name },
  balance_cents: db.prepare(`SELECT ${BALANCE_SQL} AS b FROM people pe WHERE pe.id = ?`).get(person.id).b,
  prints: listPrints(person.id),
  payments: db.prepare('SELECT id, amount_cents, paid_at, note FROM payments WHERE person_id = ? ORDER BY paid_at DESC, id DESC').all(person.id),
  wishes: db.prepare('SELECT id, title, url, note, status, created_at FROM wishes WHERE person_id = ? ORDER BY id DESC').all(person.id),
}));
route('POST', '/api/my/wishes', 'guest', ({ person, body }) => {
  const open = db.prepare("SELECT COUNT(*) AS n FROM wishes WHERE person_id = ? AND status = 'requested'").get(person.id).n;
  if (open >= 30) throw bad('Trop de demandes en attente');
  return { id: addWish(person.id, body, 'requested') };
});
route('DELETE', '/api/my/wishes/:id', 'guest', ({ person, params }) => {
  db.prepare("DELETE FROM wishes WHERE id = ? AND person_id = ? AND status = 'requested'").run(params.id, person.id);
  return { ok: true };
});

// ---------- static files ----------

const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const STATIC = new Map(
  ['style.css', 'theme.js', 'app.js', 'select.js', 'i18n.js', 'tigertag.js', 'tigertag-db.js', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon.svg', 'favicon-32.png', 'favicon.ico', 'fonts/geist-latin.woff2', 'fonts/geist-latin-ext.woff2', 'fonts/geist-mono-latin.woff2', 'fonts/geist-mono-latin-ext.woff2'].map(name => [
    '/' + name,
    { type: TYPES[path.extname(name)], data: readFileSync(path.join(__dirname, 'public', name)) },
  ])
);
// The Lucide icons the interface uses (see `icon` in public/app.js), gathered at startup from the
// lucide-static package into one small sprite: the browser loads 18 icons, not the whole set.
const ICONS = ['plus', 'scan-barcode', 'settings', 'log-out', 'sun', 'moon', 'sun-moon', 'trash-2', 'refresh-cw', 'link', 'euro', 'x', 'unlink', 'disc-3', 'box', 'users', 'heart', 'bell'];
const LUCIDE = path.join(__dirname, 'node_modules', 'lucide-static', 'icons');
const sprite = ICONS.map(name => {
  // keeps the shapes only: the page sets the stroke, so every icon draws the same
  const shapes = readFileSync(path.join(LUCIDE, `${name}.svg`), 'utf8').replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g, '');
  return `<symbol id="${name}" viewBox="0 0 24 24">${shapes}</symbol>`;
});
STATIC.set('/icons.svg', { type: 'image/svg+xml', data: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><!-- Lucide icons, ISC License: https://lucide.dev/license -->${sprite.join('')}</svg>`) });
const INDEX = readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// The manifest is per invite link so that an installed guest app reopens on the guest's own page.
function manifest(guestToken) {
  return JSON.stringify({
    name: '3D Print Dashboard',
    short_name: '3D Print Dashboard',
    start_url: guestToken ? `/g/${guestToken}` : '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0A0A0B',
    theme_color: '#F5F5F3',
    // "maskable" icons are full-bleed: the phone cuts its own shape out of them, edge to edge.
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
}

// ---------- server ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 100_000) {
        reject(new HttpError(413, 'Requête trop volumineuse'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(data && typeof data === 'object' ? data : {});
      } catch {
        reject(bad('Données invalides'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, type, data) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(data);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:");

  const client = clientKey(req);
  const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
  if (tooManyRequests(client) || (isWrite && tooManyWrites(client))) {
    res.setHeader('Retry-After', '60');
    throw new HttpError(429, 'Trop de requêtes, patientez une minute puis réessayez');
  }

  if (p.startsWith('/api/')) {
    for (const r of routes) {
      const m = r.method === req.method && r.re.exec(p);
      if (!m) continue;
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, +v]));
      const ctx = { req, res, params, person: null, body: {} };
      if (r.role === 'admin' && !isAdmin(req)) throw new HttpError(401, 'Non connecté');
      if (r.role === 'guest' && !(ctx.person = guestOf(req))) throw new HttpError(401, 'Lien d’invitation invalide');
      if (req.method !== 'GET') ctx.body = await readBody(req);
      const result = await r.fn(ctx);
      // a route that answered by itself (a picture) has nothing more to send
      if (res.headersSent) return;
      return send(res, 200, 'application/json', JSON.stringify(result));
    }
    throw new HttpError(404, 'Introuvable');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Méthode non autorisée');
  const guest = /^\/g\/([\w-]{10,64})$/.exec(p);
  if (p === '/' || guest) {
    const href = '/manifest.webmanifest' + (guest ? `?g=${guest[1]}` : '');
    return send(res, 200, 'text/html; charset=utf-8', INDEX.replace('__MANIFEST__', href));
  }
  if (p === '/manifest.webmanifest') {
    const g = url.searchParams.get('g') || '';
    return send(res, 200, 'application/manifest+json', manifest(/^[\w-]{10,64}$/.test(g) ? g : ''));
  }
  const file = STATIC.get(p);
  if (file) return send(res, 200, file.type, file.data);
  throw new HttpError(404, 'Introuvable');
}

http
  .createServer((req, res) => {
    handle(req, res).catch(e => {
      if (!e.status) console.error(e);
      if (res.headersSent) return res.end();
      send(res, e.status || 500, 'application/json', JSON.stringify({ error: e.status ? e.message : 'Erreur du serveur' }));
    });
  })
  .listen(PORT, () => console.log(`3D Print Dashboard listening on port ${PORT}`));
startLive();
