import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECURE_COOKIES = process.env.SECURE_COOKIES === 'true';
const SESSION_MS = 30 * 24 * 3600 * 1000;

if (ADMIN_PASSWORD.length < 8) {
  console.error('Set ADMIN_PASSWORD (at least 8 characters) before starting.');
  process.exit(1);
}

// ---------- database ----------

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
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
  CREATE TABLE IF NOT EXISTS prints (
    id INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    printed_at TEXT NOT NULL,
    adjust_cents INTEGER NOT NULL DEFAULT 0,
    adjust_note TEXT NOT NULL DEFAULT '',
    wish_id INTEGER REFERENCES wishes(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
const sha = s => createHash('sha256').update(s).digest();

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

// Failed-login limiter, per client address.
const failures = new Map();
function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',').pop().trim()) || req.socket.remoteAddress || '?';
}
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

function listPrints(where = '', ...args) {
  const prints = db.prepare(
    `SELECT p.id, p.person_id, pe.name AS person_name, p.title, p.printed_at, p.adjust_cents, p.adjust_note
     FROM prints p JOIN people pe ON pe.id = p.person_id ${where} ORDER BY p.printed_at DESC, p.id DESC`
  ).all(...args);
  const lines = db.prepare('SELECT label, grams, cost_cents FROM print_lines WHERE print_id = ? ORDER BY id');
  for (const p of prints) {
    p.lines = lines.all(p.id);
    p.total_cents = p.lines.reduce((sum, l) => sum + l.cost_cents, 0) + p.adjust_cents;
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

// ---------- routes ----------

const routes = [];
function route(method, pattern, role, fn) {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>\\d+)') + '$');
  routes.push({ method, re, role, fn });
}

route('POST', '/api/login', 'public', ({ req, res, body }) => {
  const key = clientKey(req);
  if (loginBlocked(key)) throw new HttpError(429, 'Too many attempts, try again later');
  if (!timingSafeEqual(sha(String(body.password ?? '')), sha(ADMIN_PASSWORD))) {
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

route('POST', '/api/prints', 'admin', ({ body }) => {
  const person = mustExist('people', int(body.person_id, 1, Number.MAX_SAFE_INTEGER, 'Person'));
  const title = str(body.title, 120, 'Title');
  const adjust = body.adjust_cents ? int(body.adjust_cents, -10000000, 10000000, 'Adjustment') : 0;
  const lines = Array.isArray(body.lines) ? body.lines.slice(0, 32) : [];
  if (!lines.length && !adjust) throw bad('Add at least one filament or an adjustment');
  return tx(() => {
    let wishId = null;
    if (body.wish_id) {
      const wish = db.prepare('SELECT id FROM wishes WHERE id = ? AND person_id = ?').get(Number(body.wish_id) || 0, person.id);
      if (wish) {
        wishId = wish.id;
        db.prepare("UPDATE wishes SET status = 'printed' WHERE id = ?").run(wishId);
      }
    }
    const id = db.prepare(
      'INSERT INTO prints (person_id, title, printed_at, adjust_cents, adjust_note, wish_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(person.id, title, day(body.printed_at), adjust, str(body.adjust_note, 200), wishId).lastInsertRowid;
    for (const line of lines) {
      const spool = mustExist('spools', int(line?.spool_id, 1, Number.MAX_SAFE_INTEGER, 'Spool'));
      const grams = num(line.grams, 0.01, 100000, 'Grams');
      const cost = Math.round((grams * spool.price_cents) / spool.weight_g);
      const label = [spool.brand, spool.material, spool.variant, spool.color_name].filter(Boolean).join(' ');
      db.prepare('INSERT INTO print_lines (print_id, spool_id, label, grams, cost_cents) VALUES (?, ?, ?, ?, ?)').run(id, spool.id, label, grams, cost);
      db.prepare('UPDATE spools SET remaining_g = MAX(0, remaining_g - ?) WHERE id = ?').run(grams, spool.id);
    }
    return { id };
  });
});
route('DELETE', '/api/prints/:id', 'admin', ({ params }) =>
  tx(() => {
    // give the filament back to the spools that still exist
    for (const l of db.prepare('SELECT spool_id, grams FROM print_lines WHERE print_id = ? AND spool_id IS NOT NULL').all(params.id)) {
      db.prepare('UPDATE spools SET remaining_g = remaining_g + ? WHERE id = ?').run(l.grams, l.spool_id);
    }
    db.prepare('DELETE FROM prints WHERE id = ?').run(params.id);
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
  prints: listPrints('WHERE p.person_id = ?', person.id),
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

const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
const STATIC = new Map(
  ['style.css', 'app.js', 'i18n.js', 'sw.js', 'icon-192.png', 'icon-512.png'].map(name => [
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
    background_color: '#111827',
    theme_color: '#111827',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
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

  if (p.startsWith('/api/')) {
    for (const r of routes) {
      const m = r.method === req.method && r.re.exec(p);
      if (!m) continue;
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, +v]));
      const ctx = { req, res, params, person: null, body: {} };
      if (r.role === 'admin' && !isAdmin(req)) throw new HttpError(401, 'Not signed in');
      if (r.role === 'guest' && !(ctx.person = guestOf(req))) throw new HttpError(401, 'Invalid invite link');
      if (req.method !== 'GET') ctx.body = await readBody(req);
      return send(res, 200, 'application/json', JSON.stringify(r.fn(ctx)));
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
