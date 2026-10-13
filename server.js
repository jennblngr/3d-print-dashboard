import http from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseHash, verifyPassword } from './auth.js';
import { createBackup, pruneBackups, lastBackupAt } from './backup.js';
import { BambuError, requestCode, login as bambuLogin, recentPrints } from './bambu.js';

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
const db = new DatabaseSync(DB_FILE);

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
    variant TEXT NOT NULL DEFAULT ''
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
  CREATE TABLE IF NOT EXISTS prints (
    id INTEGER PRIMARY KEY,
    person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    printed_at TEXT NOT NULL,
    adjust_cents INTEGER NOT NULL DEFAULT 0,
    adjust_note TEXT NOT NULL DEFAULT '',
    wish_id INTEGER REFERENCES wishes(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    group_id INTEGER
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
    grams REAL
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
  if (s.length > max) throw bad(`${name || 'Text'} is too long`);
  if (name && !s) throw bad(`${name} is required`);
  return s;
}
function num(v, min, max, name) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw bad(`${name} is invalid`);
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

const BALANCE_SQL = `
  COALESCE((SELECT SUM(l.cost_cents) FROM print_lines l JOIN prints p ON p.id = l.print_id WHERE p.person_id = pe.id), 0)
  + COALESCE((SELECT SUM(adjust_cents) FROM prints WHERE person_id = pe.id), 0)
  - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE person_id = pe.id), 0)`;

// `guestId` limits the list to one person's prints and leaves out who else shares them:
// a guest learns that a print is shared, never with whom.
function listPrints(guestId) {
  const prints = db.prepare(
    `SELECT p.id, p.person_id, pe.name AS person_name, p.title, p.printed_at, p.adjust_cents, p.adjust_note, p.group_id
     FROM prints p LEFT JOIN people pe ON pe.id = p.person_id ${guestId ? 'WHERE p.person_id = ?' : ''}
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
  const weight = num(b.weight_g, 1, 100000, 'Weight');
  return [
    str(b.brand, 80, 'Brand'),
    str(b.material, 40),
    str(b.color_name, 60),
    /^#[0-9a-f]{6}$/i.test(b.color_hex) ? b.color_hex : '#888888',
    int(b.price_cents, 0, 10000000, 'Price'),
    weight,
    b.remaining_g == null || b.remaining_g === '' ? weight : num(b.remaining_g, 0, 100000, 'Remaining weight'),
    str(b.code, 500) || null,
    str(b.notes, 1000),
    b.archived ? 1 : 0,
    str(b.barcode, 500) || null,
    str(b.variant, 40),
  ];
}
function saveSpool(values, fn) {
  let result;
  try {
    result = fn();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Another spool already uses this RFID tag');
    throw e;
  }
  const [brand, material, colorName, colorHex, price, weight] = values;
  const [barcode, variant] = values.slice(-2);
  if (barcode) {
    db.prepare(
      'INSERT OR REPLACE INTO products (barcode, brand, material, color_name, color_hex, price_cents, weight_g, variant) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(barcode, brand, material, colorName, colorHex, price, weight, variant);
  }
  return result;
}
function mustExist(table, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, 'Not found');
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
// to the rest: its Bambu Lab print, the wish it answered, and when it was first recorded.
function editPrint(id, body) {
  const before = printSnapshot(id);
  const bambuIds = removePrint(before);
  const { id: newId } = createPrint({ ...body, wish_id: null }, before.lines);
  const created = db.prepare('SELECT id, person_id FROM prints WHERE id = ? OR group_id = ?').all(newId, newId);
  for (const p of created) {
    const wishId = before.prints.find(o => o.person_id !== null && o.person_id === p.person_id)?.wish_id ?? null;
    db.prepare('UPDATE prints SET wish_id = ?, created_at = ? WHERE id = ?').run(wishId, before.prints[0].created_at, p.id);
  }
  for (const b of bambuIds) db.prepare("UPDATE bambu_prints SET state = 'billed', print_id = ? WHERE id = ?").run(newId, b);
  return { id: newId };
}

// Must run inside tx(): takes a print's filament out of the spools and bills it.
// `person_ids` lists who it is for; null stands for the owner, whose part is billed to nobody.
// Several people share a print in equal parts: each gets a print of their own holding their
// part of the filament and of the adjustment, so every amount is computed as for any print.
// `previous` is only given when a print is edited: the filament it already used keeps the
// cost it was billed at (see printSnapshot).
function createPrint(body, previous = null) {
  const asked = Array.isArray(body.person_ids) ? body.person_ids.slice(0, 50) : [body.person_id];
  const ids = [...new Set(asked.map(v => {
    if (v === undefined) throw bad('Person is required');
    return v === null ? null : int(v, 1, Number.MAX_SAFE_INTEGER, 'Person');
  }))];
  if (!ids.length) throw bad('Person is required');
  const people = ids.map(id => (id === null ? null : mustExist('people', id)));
  const parts = people.length;
  const title = str(body.title, 120, 'Title');
  const printedAt = day(body.printed_at);
  // an adjustment is a billing matter: it means nothing on a part nobody pays for
  const billed = people.some(Boolean);
  const adjust = billed && body.adjust_cents ? int(body.adjust_cents, -10000000, 10000000, 'Adjustment') : 0;
  const note = str(body.adjust_note, 200);
  const lines = (Array.isArray(body.lines) ? body.lines.slice(0, 32) : []).map(line => {
    const grams = num(line?.grams, 0.01, 100000, 'Grams') / parts;
    // a line kept from the print being edited whose spool was deleted since: no stock to move
    if (line.spool_id == null && previous) {
      const kept = previous.get(lineKey(null, line.label));
      if (!kept) throw bad('Spool is required');
      return { spool: null, label: kept.label, grams, cost: lineCost(kept, null, grams, parts) };
    }
    const spool = mustExist('spools', int(line.spool_id, 1, Number.MAX_SAFE_INTEGER, 'Spool'));
    const label = spoolLabel(spool);
    const kept = previous?.get(lineKey(spool.id));
    return { spool, label, grams, cost: kept ? lineCost(kept, spool, grams, parts) : spoolCost(spool, grams) };
  });
  if (!lines.length && !adjust) throw bad(billed ? 'Add at least one filament or an adjustment' : 'Add at least one filament');

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
      'INSERT INTO prints (person_id, title, printed_at, adjust_cents, adjust_note, wish_id, group_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(person?.id ?? null, title, printedAt, person ? Math.round(adjust / parts) : 0, person ? note : '', wishId, groupId).lastInsertRowid;
    if (parts > 1 && groupId === null) {
      groupId = id;
      db.prepare('UPDATE prints SET group_id = ? WHERE id = ?').run(groupId, id);
    }
    for (const { spool, label, grams, cost } of lines) {
      db.prepare('INSERT INTO print_lines (print_id, spool_id, label, grams, cost_cents) VALUES (?, ?, ?, ?, ?)').run(id, spool?.id ?? null, label, grams, cost);
      if (!spool) continue;
      db.prepare('UPDATE spools SET remaining_g = MAX(0, remaining_g - ?) WHERE id = ?').run(grams, spool.id);
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
  return b ? { connected: true, last_sync: b.lastSync || null, error: b.error || null } : { connected: false };
}

let bambuSyncing = null;
// Files the prints that ended since the account was connected, to be assigned by the owner.
function syncBambu() {
  bambuSyncing ??= (async () => {
    const account = getSetting('bambu');
    if (!account) return;
    let error = null;
    try {
      const add = db.prepare(
        'INSERT OR IGNORE INTO bambu_prints (id, title, failed, ended_at, material, planned_g, suggested_g) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const p of await recentPrints(account.token)) {
        if (p.endedAt < account.since) continue;
        add.run(p.id, p.title, p.failed ? 1 : 0, p.endedAt, p.material, p.plannedGrams, p.suggestedGrams);
      }
    } catch (e) {
      if (!(e instanceof BambuError)) throw e;
      error = e.reason;
    }
    // The owner may have disconnected or signed in again while Bambu was answering.
    const current = getSetting('bambu');
    if (current?.token !== account.token) return;
    setSetting('bambu', { ...current, error, lastSync: error ? current.lastSync : new Date().toISOString() });
  })().finally(() => {
    bambuSyncing = null;
  });
  return bambuSyncing;
}
const syncBambuQuietly = () => syncBambu().catch(e => console.error(`Bambu sync failed: ${e.message}`));
setInterval(syncBambuQuietly, BAMBU_SYNC_MS).unref();
syncBambuQuietly();

function bambuHttpError(e) {
  if (!(e instanceof BambuError)) return e;
  return new HttpError(502, e.reason === 'unreachable' ? 'Bambu Lab cannot be reached, try again later' : 'Bambu Lab refused: check the email address and the code');
}
function pendingBambuPrint(id) {
  const row = mustExist('bambu_prints', id);
  if (row.state !== 'pending') throw new HttpError(409, 'This print was already handled');
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
  if (loginBlocked(key)) throw new HttpError(429, 'Too many attempts, try again later');
  const password = typeof body.password === 'string' ? body.password.slice(0, 1000) : '';
  if (!(await verifyPassword(password, ADMIN_PASSWORD_HASH))) {
    loginFailed(key);
    throw new HttpError(401, 'Wrong password');
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
    `SELECT id, title, failed, ended_at, material, planned_g, suggested_g, state, spool_id, grams
     FROM bambu_prints WHERE state != 'billed' ORDER BY state = 'pending' DESC, ended_at DESC LIMIT 200`
  ).all(),
  last_spool_id: getSetting('last_spool_id'),
  spools: db.prepare('SELECT * FROM spools ORDER BY archived, brand COLLATE NOCASE, material, variant, color_name').all(),
  products: db.prepare('SELECT * FROM products').all(),
  people: db.prepare(`SELECT pe.id, pe.name, pe.token, ${BALANCE_SQL} AS balance_cents FROM people pe ORDER BY pe.name COLLATE NOCASE`).all(),
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
      `INSERT INTO spools (brand, material, color_name, color_hex, price_cents, weight_g, remaining_g, code, notes, archived, barcode, variant)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...values).lastInsertRowid,
  }));
});
route('PUT', '/api/spools/:id', 'admin', ({ params, body }) => {
  mustExist('spools', params.id);
  const values = spoolInput(body);
  saveSpool(values, () =>
    db.prepare(
      `UPDATE spools SET brand = ?, material = ?, color_name = ?, color_hex = ?, price_cents = ?, weight_g = ?,
       remaining_g = ?, code = ?, notes = ?, archived = ?, barcode = ?, variant = ? WHERE id = ?`
    ).run(...values, params.id)
  );
  return { ok: true };
});
route('DELETE', '/api/spools/:id', 'admin', ({ params }) => {
  db.prepare('DELETE FROM spools WHERE id = ?').run(params.id);
  return { ok: true };
});

route('POST', '/api/people', 'admin', ({ body }) => ({
  id: db.prepare('INSERT INTO people (name, token) VALUES (?, ?)').run(str(body.name, 60, 'Name'), newToken()).lastInsertRowid,
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
  await requestCode(str(body.email, 200, 'Email')).catch(e => {
    throw bambuHttpError(e);
  });
  return { ok: true };
});
route('POST', '/api/bambu/login', 'admin', async ({ body }) => {
  const email = str(body.email, 200, 'Email');
  const code = str(body.code, 12, 'Code');
  const { token, expiresAt } = await bambuLogin(email, code).catch(e => {
    throw bambuHttpError(e);
  });
  // Only prints that end from now on are picked up: the older history is left alone.
  setSetting('bambu', { token, expiresAt, since: getSetting('bambu')?.since || new Date().toISOString() });
  await syncBambu();
  return { ok: true };
});
route('DELETE', '/api/bambu', 'admin', () => {
  db.prepare("DELETE FROM settings WHERE key = 'bambu'").run();
  return { ok: true };
});
route('POST', '/api/bambu/sync', 'admin', async () => {
  await syncBambu();
  return bambuStatus();
});
route('POST', '/api/bambu/prints/:id/bill', 'admin', ({ params, body }) =>
  tx(() => {
    if (pendingBambuPrint(params.id).failed) throw bad('A failed print cannot be billed');
    const { id } = createPrint(body);
    db.prepare("UPDATE bambu_prints SET state = 'billed', print_id = ? WHERE id = ?").run(id, params.id);
    return { id };
  })
);
// Filament used for nobody's bill (a failed print, or one for the owner): only the stock moves.
route('POST', '/api/bambu/prints/:id/stock', 'admin', ({ params, body }) =>
  tx(() => {
    pendingBambuPrint(params.id);
    const spool = mustExist('spools', int(body.spool_id, 1, Number.MAX_SAFE_INTEGER, 'Spool'));
    const grams = num(body.grams, 0.01, 100000, 'Grams');
    // what is recorded is what really left the spool, so that undoing gives back exactly that
    const taken = Math.min(grams, spool.remaining_g);
    db.prepare('UPDATE spools SET remaining_g = remaining_g - ? WHERE id = ?').run(taken, spool.id);
    db.prepare("UPDATE bambu_prints SET state = 'stock', spool_id = ?, grams = ? WHERE id = ?").run(spool.id, taken, params.id);
    setSetting('last_spool_id', spool.id);
    return { ok: true };
  })
);
route('POST', '/api/bambu/prints/:id/ignore', 'admin', ({ params }) => {
  pendingBambuPrint(params.id);
  db.prepare("UPDATE bambu_prints SET state = 'ignored' WHERE id = ?").run(params.id);
  return { ok: true };
});
// Undo "stock" or "ignore": the filament goes back to its spool and the print waits again.
route('POST', '/api/bambu/prints/:id/reset', 'admin', ({ params }) =>
  tx(() => {
    const row = mustExist('bambu_prints', params.id);
    if (row.state !== 'stock' && row.state !== 'ignored') throw new HttpError(409, 'This print cannot be put back');
    if (row.state === 'stock' && row.spool_id) {
      db.prepare('UPDATE spools SET remaining_g = remaining_g + ? WHERE id = ?').run(row.grams, row.spool_id);
    }
    db.prepare("UPDATE bambu_prints SET state = 'pending', spool_id = NULL, grams = NULL WHERE id = ?").run(params.id);
    return { ok: true };
  })
);

route('POST', '/api/payments', 'admin', ({ body }) => {
  const person = mustExist('people', int(body.person_id, 1, Number.MAX_SAFE_INTEGER, 'Person'));
  return {
    id: db.prepare('INSERT INTO payments (person_id, amount_cents, paid_at, note) VALUES (?, ?, ?, ?)').run(
      person.id, int(body.amount_cents, 1, 10000000, 'Amount'), day(body.paid_at), str(body.note, 200)
    ).lastInsertRowid,
  };
});
route('DELETE', '/api/payments/:id', 'admin', ({ params }) => {
  db.prepare('DELETE FROM payments WHERE id = ?').run(params.id);
  return { ok: true };
});

route('PUT', '/api/wishes/:id', 'admin', ({ params, body }) => {
  if (!['requested', 'accepted', 'printed', 'declined'].includes(body.status)) throw bad('Status is invalid');
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
  if (open >= 30) throw bad('Too many pending requests');
  const url = str(body.url, 500);
  if (url && !/^https?:\/\//i.test(url)) throw bad('The link must start with http:// or https://');
  return {
    id: db.prepare('INSERT INTO wishes (person_id, title, url, note) VALUES (?, ?, ?, ?)').run(
      person.id, str(body.title, 120, 'Title'), url, str(body.note, 500)
    ).lastInsertRowid,
  };
});
route('DELETE', '/api/my/wishes/:id', 'guest', ({ person, params }) => {
  db.prepare("DELETE FROM wishes WHERE id = ? AND person_id = ? AND status = 'requested'").run(params.id, person.id);
  return { ok: true };
});

// ---------- static files ----------

const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2' };
const STATIC = new Map(
  ['style.css', 'app.js', 'i18n.js', 'tigertag.js', 'tigertag-db.js', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png', 'fonts/urbanist.woff2'].map(name => [
    '/' + name,
    { type: TYPES[path.extname(name)], data: readFileSync(path.join(__dirname, 'public', name)) },
  ])
);
const INDEX = readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// The manifest is per invite link so that an installed guest app reopens on the guest's own page.
function manifest(guestToken) {
  return JSON.stringify({
    name: '3D Print Dashboard',
    short_name: '3D Prints',
    start_url: guestToken ? `/g/${guestToken}` : '/',
    scope: '/',
    display: 'standalone',
    background_color: '#F3F3F6',
    theme_color: '#F3F3F6',
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
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(data && typeof data === 'object' ? data : {});
      } catch {
        reject(bad('Invalid JSON'));
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
    throw new HttpError(429, 'Too many requests, wait a minute and try again');
  }

  if (p.startsWith('/api/')) {
    for (const r of routes) {
      const m = r.method === req.method && r.re.exec(p);
      if (!m) continue;
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, +v]));
      const ctx = { req, res, params, person: null, body: {} };
      if (r.role === 'admin' && !isAdmin(req)) throw new HttpError(401, 'Not signed in');
      if (r.role === 'guest' && !(ctx.person = guestOf(req))) throw new HttpError(401, 'Invalid invite link');
      if (req.method !== 'GET') ctx.body = await readBody(req);
      return send(res, 200, 'application/json', JSON.stringify(await r.fn(ctx)));
    }
    throw new HttpError(404, 'Not found');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
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
  throw new HttpError(404, 'Not found');
}

http
  .createServer((req, res) => {
    handle(req, res).catch(e => {
      if (!e.status) console.error(e);
      if (res.headersSent) return res.end();
      send(res, e.status || 500, 'application/json', JSON.stringify({ error: e.status ? e.message : 'Server error' }));
    });
  })
  .listen(PORT, () => console.log(`3D Print Dashboard listening on port ${PORT}`));
