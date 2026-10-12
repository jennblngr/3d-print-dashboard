// Owner password handling: only a salted scrypt hash is ever stored, never the password itself.
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const LOG_N = 15; // scrypt work factor used for new hashes (N = 2^15, r = 8, p = 1)
export const MIN_PASSWORD_LENGTH = 12;

function derive(password, salt, logN) {
  const N = 2 ** logN;
  return scryptAsync(password.normalize('NFKC'), salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 });
}

// Stored format: scrypt:<log2 N>:<salt>:<key>, both base64url. No "$" so it survives .env files untouched.
export function parseHash(stored) {
  const m = /^scrypt:(\d{2}):([\w-]{22}):([\w-]{43})$/.exec(stored || '');
  if (!m || +m[1] < 14 || +m[1] > 20) return null;
  return { logN: +m[1], salt: Buffer.from(m[2], 'base64url'), key: Buffer.from(m[3], 'base64url') };
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, LOG_N);
  return `scrypt:${LOG_N}:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const hash = parseHash(stored);
  if (!hash) return false;
  return timingSafeEqual(await derive(password, hash.salt, hash.logN), hash.key);
}
