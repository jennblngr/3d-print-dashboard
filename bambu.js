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
    const material = hit.amsDetailMapping?.[0]?.filamentType;
    prints.push({
      id: hit.id,
      title: title.trim().slice(0, 120),
      failed,
      endedAt: new Date(ended).toISOString(),
      material: typeof material === 'string' ? material.slice(0, 40) : '',
      plannedGrams: grams,
      suggestedGrams: Math.round(grams * share * 10) / 10,
    });
  }
  return prints;
}
