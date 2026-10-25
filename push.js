// Web Push without a library: the message is encrypted for the browser that subscribed
// (RFC 8291) and signed with this server's key (VAPID, RFC 8292). The push service that carries
// it (Google's for Chrome) cannot read it.
import { createECDH, createCipheriv, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';

// The push services of the browsers: the server only ever posts to these.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;

export function newVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ format: 'jwk' });
}

// The public half, in the form browsers take as `applicationServerKey`.
export const vapidPublicKey = jwk =>
  Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');

// Checks what a browser handed over when subscribing; returns null if it is not a usable subscription.
export function readSubscription(v) {
  const endpoint = typeof v?.endpoint === 'string' ? v.endpoint : '';
  const p256dh = typeof v?.keys?.p256dh === 'string' ? Buffer.from(v.keys.p256dh, 'base64url') : null;
  const auth = typeof v?.keys?.auth === 'string' ? Buffer.from(v.keys.auth, 'base64url') : null;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (endpoint.length > 1000 || url.protocol !== 'https:' || !PUSH_HOSTS.test(url.hostname)) return null;
  if (p256dh?.length !== 65 || p256dh[0] !== 4 || auth?.length !== 16) return null;
  return { endpoint, p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') };
}

const hkdf = (salt, ikm, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

// RFC 8291: one aes128gcm record. `local` and `salt` are only given by the tests.
export function encrypt(payload, sub, { local, salt = randomBytes(16) } = {}) {
  const uaPublic = Buffer.from(sub.p256dh, 'base64url');
  if (!local) {
    local = createECDH('prime256v1');
    local.generateKeys();
  }
  const asPublic = local.getPublicKey();
  const secret = local.computeSecret(uaPublic);
  const ikm = hkdf(Buffer.from(sub.auth, 'base64url'), secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const key = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  // 0x02 marks the last (and only) record
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

function vapidToken(jwk, endpoint, contact) {
  const part = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact })}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${signature.toString('base64url')}`;
}

// Sends one message. Resolves to 'sent', 'gone' (the browser dropped the subscription: forget it)
// or 'failed'.
export async function sendPush(sub, message, jwk, contact) {
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${vapidToken(jwk, sub.endpoint, contact)}, k=${vapidPublicKey(jwk)}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(24 * 3600),
        Urgency: 'high',
      },
      body: encrypt(JSON.stringify(message), sub),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
