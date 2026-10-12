// Asks for the owner password and saves its hash (never the password) in .env.
// Usage: npm run set-password
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth.js';

const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
const { stdin, stdout } = process;

// Reads one line without showing it on screen.
function readHidden(prompt) {
  return new Promise(resolve => {
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
    };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          return resolve(value);
        }
        if (ch === '\u0003') {
          finish();
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// Piped input (no keyboard): the first line is the password.
async function readPiped() {
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data.split(/\r?\n/)[0];
}

let password;
if (stdin.isTTY) {
  password = await readHidden(`New owner password (at least ${MIN_PASSWORD_LENGTH} characters): `);
  if ((await readHidden('Type it again: ')) !== password) {
    console.error('The two entries differ. Nothing was changed.');
    process.exit(1);
  }
} else {
  password = await readPiped();
}
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Too short: use at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.`);
  process.exit(1);
}

const line = `ADMIN_PASSWORD_HASH=${await hashPassword(password)}`;
const kept = existsSync(envFile)
  ? readFileSync(envFile, 'utf8').split('\n').filter(l => !/^ADMIN_PASSWORD(_HASH)?=/.test(l) && l !== '')
  : [];
writeFileSync(envFile, [...kept, line].join('\n') + '\n', { mode: 0o600 });
chmodSync(envFile, 0o600);
console.log('Saved. The .env file now holds a hash of the password, not the password itself.');
console.log('Restart the app for the change to take effect.');
