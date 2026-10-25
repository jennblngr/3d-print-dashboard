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

// The parts of a shared print (one per person) gathered under one entry, in the order the
// server listed them; a print that is not shared is a group of one.
export function groupPrints(prints) {
  const groups = new Map();
  for (const p of prints) {
    const key = p.group_id ?? p.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.values()].map(parts => parts.sort((a, b) => a.id - b.id));
}

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
// The spool a Bambu print most likely used: the same material and the closest colour.
// Without a close enough colour, the spool used last. `matched` says whether the choice comes from what Bambu reported.
export function suggestSpool(state, b) {
  const norm = v => (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pool = activeSpools(state).filter(s => !b.material || norm(s.material) === norm(b.material));
  if (b.color_hex && pool.length) {
    const best = pool.reduce((x, y) => (colorDistance(y.color_hex, b.color_hex) < colorDistance(x.color_hex, b.color_hex) ? y : x));
    if (colorDistance(best.color_hex, b.color_hex) <= 120) return { id: best.id, matched: true };
  }
  if (!b.color_hex && pool.length === 1) return { id: pool[0].id, matched: true };
  return { id: state.last_spool_id, matched: false };
}

// The past prints a new one can start from, in the server's order (newest first), a shared
// print listed once.
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
  }));
}
