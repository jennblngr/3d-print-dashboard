// Read-only client for the Bambu Lab account history. This is the interface Bambu's own apps use,
// not a documented one: it can change without notice, so every answer is treated as untrusted.
const API = 'https://api.bambulab.com';
const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent': 'bambu_network_agent/01.09.05.01',
  'X-BBL-Client-Name': 'OrcaSlicer',
  'X-BBL-Client-Type': 'slicer',
  'X-BBL-Client-Version': '01.09.05.51',
  'X-BBL-Language': 'en-US',
  'X-BBL-OS-Type': 'linux',
  'X-BBL-OS-Version': '6.2.0',
  'X-BBL-Agent-Version': '01.09.05.01',
  'X-BBL-Executable-info': '{}',
  'X-BBL-Agent-OS-Type': 'linux',
};
const FINISHED = 2;
const FAILED = 3;

export class BambuError extends Error {
  // reason: 'refused' (Bambu said no), 'expired' (sign in again), 'unreachable' (network or bad answer)
  constructor(reason) {
    super(`Bambu Lab: ${reason}`);
    this.reason = reason;
  }
}

async function call(method, path, { body, token } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: token ? { ...HEADERS, Authorization: `Bearer ${token}` } : HEADERS,
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BambuError('unreachable');
  }
  if (res.status === 401 || res.status === 403) throw new BambuError(token ? 'expired' : 'refused');
  if (res.status >= 400 && res.status < 500) throw new BambuError('refused');
  if (!res.ok) throw new BambuError('unreachable');
  // Some calls answer with an empty body: the caller decides whether that is acceptable.
  const data = await res.json().catch(() => null);
  return data && typeof data === 'object' ? data : {};
}

// Asks Bambu to email a one-time sign-in code: the account password is never needed here.
export async function requestCode(email) {
  await call('POST', '/v1/user-service/user/sendemail/code', { body: { email, type: 'codeLogin' } });
}

export async function login(email, code) {
  const data = await call('POST', '/v1/user-service/user/login', { body: { account: email, code } });
  if (typeof data.accessToken !== 'string' || !data.accessToken) throw new BambuError('refused');
  const lifetime = Number.isFinite(data.expiresIn) && data.expiresIn > 0 ? data.expiresIn : 90 * 24 * 3600;
  return { token: data.accessToken, expiresAt: Date.now() + lifetime * 1000 };
}

// The account's number, which names it on Bambu's live connection (see bambu-live.js).
export async function accountUid(token) {
  const data = await call('GET', '/v1/design-user-service/my/preference', { token });
  const uid = String(data.uid ?? '');
  if (!/^\d{1,20}$/.test(uid)) throw new BambuError('unreachable');
  return uid;
}

// The printers bound to the account.
export async function printers(token) {
  const data = await call('GET', '/v1/iot-service/api/user/bind', { token });
  if (!Array.isArray(data.devices)) throw new BambuError('unreachable');
  return data.devices
    .filter(d => typeof d?.dev_id === 'string' && /^[\w-]{1,64}$/.test(d.dev_id))
    .map(d => ({ id: d.dev_id, name: (typeof d.name === 'string' && d.name.trim().slice(0, 60)) || d.dev_id }));
}

// The picture of a print's model, as Bambu stores it. Only images from Bambu's own storage are
// fetched, and kept small: null when there is none or it does not look right.
const COVER_HOSTS = /(^|\.)(amazonaws\.com|aliyuncs\.com|bblmw\.com|bambulab\.com|bambulab\.cn)$/;
const MAX_COVER = 1_000_000;
export async function fetchCover(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !COVER_HOSTS.test(url.hostname)) return null;
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!res.ok || +res.headers.get('content-length') > MAX_COVER) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_COVER) return null;
    // the type comes from the file itself, never from what the other side says it is
    const type = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
      : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? 'image/jpeg'
      : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP' ? 'image/webp'
      : null;
    return type && { type, data };
  } catch {
    return null;
  }
}

// The latest prints that are over (finished, failed or cancelled), newest first.
export async function recentPrints(token) {
  const data = await call('GET', '/v1/user-service/my/tasks?limit=50', { token });
  if (!Array.isArray(data.hits)) throw new BambuError('unreachable');
  const prints = [];
  for (const hit of data.hits) {
    const started = Date.parse(hit?.startTime);
    const ended = Date.parse(hit?.endTime);
    const grams = hit?.weight;
    if (!Number.isSafeInteger(hit?.id) || hit.id <= 0) continue;
    if (hit.status !== FINISHED && hit.status !== FAILED) continue;
    if (!Number.isFinite(ended) || typeof grams !== 'number' || !(grams > 0) || grams > 100000) continue;
    const failed = hit.status === FAILED;
    // Bambu only reports the planned weight. For a print that stopped early, assume the filament
    // went out at a steady pace: the share of the planned time that elapsed is the share used.
    let share = 1;
    if (failed) {
      const planned = hit.costTime;
      share = Number.isFinite(started) && planned > 0 ? Math.min(1, Math.max(0, (ended - started) / 1000 / planned)) : 0;
    }
    const title = [hit.designTitle, hit.title].find(s => typeof s === 'string' && s.trim()) || 'Bambu print';
    const filament = hit.amsDetailMapping?.[0];
    const material = filament?.filamentType;
    // colours come as RRGGBBAA
    const color = [filament?.targetColor, filament?.sourceColor].find(c => typeof c === 'string' && /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c));
    prints.push({
      id: hit.id,
      title: title.trim().slice(0, 120),
      failed,
      endedAt: new Date(ended).toISOString(),
      material: typeof material === 'string' ? material.slice(0, 40) : '',
      color: color ? '#' + color.slice(0, 6).toLowerCase() : '',
      cover: typeof hit.cover === 'string' ? hit.cover : '',
      plannedGrams: grams,
      suggestedGrams: Math.round(grams * share * 10) / 10,
    });
  }
  return prints;
}
