// Lists the backups, or puts one back in place of the current database.
// Stop the app first. The database being replaced is itself saved as before-restore-<date>.db.
// Usage: npm run restore            (list)
//        npm run restore -- <name>  (restore)
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { backupDir, createBackup, isHealthy } from '../backup.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const dir = backupDir(dataDir);
const dbFile = path.join(dataDir, 'app.db');
const name = process.argv[2];

const available = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.db')).sort() : [];

if (!name) {
  if (!available.length) console.log(`No backup yet in ${dir}`);
  for (const f of available) console.log(`${f}  ${(statSync(path.join(dir, f)).size / 1024).toFixed(0)} KB`);
  if (available.length) console.log('\nTo restore one, stop the app, then: npm run restore -- <name>');
  process.exit(0);
}

if (!available.includes(name)) {
  console.error(`Unknown backup "${name}". Run "npm run restore" to list them.`);
  process.exit(1);
}
const source = path.join(dir, name);
if (!isHealthy(source)) {
  console.error('This backup is damaged. Nothing was changed.');
  process.exit(1);
}

if (existsSync(dbFile)) {
  const current = new DatabaseSync(dbFile);
  const saved = createBackup(current, dataDir, 'before-restore');
  current.close();
  console.log(`Current database saved as ${path.basename(saved)}`);
}
// Leftover journal files belong to the database being replaced and must not be replayed onto the restored one.
rmSync(dbFile + '-wal', { force: true });
rmSync(dbFile + '-shm', { force: true });
copyFileSync(source, dbFile);
console.log(`Restored ${name}. Start the app again.`);
