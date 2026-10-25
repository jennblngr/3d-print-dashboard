import { t, lang } from './i18n.js';

// A path like /g/<token> is a guest's private page; anything else is the owner's area.
export const guestToken = (location.pathname.match(/^\/g\/([\w-]+)$/) || [])[1];

const money = new Intl.NumberFormat(lang, { style: 'currency', currency: 'EUR' });
export const eur = cents => money.format(cents / 100);
export const fmtGrams = (g, digits = 2) => g.toLocaleString(lang, { maximumFractionDigits: digits });
export const toCents = v => Math.round(parseFloat(String(v || '0').replace(',', '.')) * 100) || 0;
export const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD in local time
export const showDate = d => new Date(d + 'T00:00').toLocaleDateString(lang);
export const localDay = iso => new Date(iso).toLocaleDateString('sv');
export const spoolName = s => [s.brand, s.material, s.variant, s.color_name].filter(Boolean).join(' ');
export const isLink = s => /^https?:\/\//i.test(s || '');
export const activeSpools = state => state.spools.filter(s => !s.archived);

// A print without a person is one the owner made for themselves: it is billed to nobody.
export const isMine = p => p.person_id == null;
export const toDecide = p => !isMine(p) && p.billing === 'pending';

export async function api(method, url, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (guestToken) headers['X-Invite'] = guestToken;
  const res = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

// ---------- theme ----------

// The theme is a choice of this device only (see theme.js); empty follows the device setting.
export const THEME_KEYS = { '': 'themeAuto', light: 'themeLight', dark: 'themeDark' }; // i18n and icon keys
export const currentTheme = () => document.documentElement.dataset.theme || '';
export function setTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try {
    if (theme) localStorage.setItem('theme', theme);
    else localStorage.removeItem('theme');
  } catch {}
}

// ---------- spool suggested for a Bambu print ----------

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
// how far apart two colours look ("redmean" distance: 0 the same, about 765 black to white)
function colorDistance(a, b) {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const r = (r1 + r2) / 2;
  return Math.sqrt((2 + r / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - r) / 256) * (b1 - b2) ** 2);
}
// The spool a Bambu print most likely used: the same material and the closest colour, an
// opened spool with filament left before a sealed or empty one. Without a close enough colour,
// the spool used last. `matched` says whether the choice comes from what Bambu reported.
export function suggestSpool(state, b) {
  const norm = v => (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pool = activeSpools(state).filter(s => !b.material || norm(s.material) === norm(b.material));
  if (b.color_hex && pool.length) {
    const score = s => colorDistance(s.color_hex, b.color_hex) + (s.sealed ? 30 : 0) + (s.remaining_g <= 0 ? 200 : 0);
    const best = pool.reduce((x, y) => (score(y) < score(x) ? y : x));
    if (colorDistance(best.color_hex, b.color_hex) <= 120) return { id: best.id, matched: true };
  }
  if (!b.color_hex && pool.length === 1) return { id: pool[0].id, matched: true };
  return { id: state.last_spool_id, matched: false };
}

// The spool most likely to take over from one that ran out: the same product, then the same
// filament; one already opened before a sealed one.
export function nextSpool(state, spool) {
  const others = activeSpools(state).filter(s => s.id !== spool.id);
  const tests = [
    s => spool.barcode && s.barcode === spool.barcode,
    s => ['brand', 'material', 'variant', 'color_name'].every(k => s[k] === spool[k]),
    s => s.material === spool.material && s.color_name === spool.color_name,
  ];
  for (const test of tests) {
    const hits = others.filter(test);
    if (hits.length) return hits.find(s => !s.sealed && s.remaining_g > 0) || hits.find(s => s.sealed) || hits[0];
  }
  return others[0] || null;
}

// The past prints a new one can start from, newest first, a shared print listed once.
export function copySources(state) {
  const seen = new Set();
  return state.prints.filter(p => {
    const key = JSON.stringify(p.edit);
    return !seen.has(key) && seen.add(key);
  }).map(p => ({
    id: p.id,
    title: p.title,
    printed_at: p.printed_at,
    who: p.edit.person_ids.map(id => (id === null ? t('me') : state.people.find(x => x.id === id)?.name)).join(', '),
  })).sort((a, b) => b.printed_at.localeCompare(a.printed_at) || b.id - a.id);
}
