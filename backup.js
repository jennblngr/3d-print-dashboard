// Database backups: verified snapshots kept next to the data, in <data dir>/backups.
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const KEEP_DAYS = 14;
export const backupDir = dataDir => path.join(dataDir, 'backups');

export function isHealthy(file) {
  let copy;
  try {
    copy = new DatabaseSync(file, { readOnly: true });
    return copy.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
  } catch {
    return false;
  } finally {
    copy?.close();
  }
}

// Automatic backups, oldest first. Names sort by date: app-2026-10-12T11-41-49-123Z.db
export function listBackups(dataDir) {
  try {
    return readdirSync(backupDir(dataDir)).filter(f => /^app-[\dTZ-]+\.db$/.test(f)).sort();
  } catch {
    return [];
  }
}

export function lastBackupAt(dataDir) {
  const m = /^app-(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3}Z)\.db$/.exec(listBackups(dataDir).at(-1) || '');
  return m ? `${m[1]}:${m[2]}:${m[3]}.${m[4]}` : null;
}

// Writes a consistent snapshot of the open database and checks that it can be read back.
export function createBackup(db, dataDir, prefix = 'app') {
  const dir = backupDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  if (!isHealthy(file)) {
    rmSync(file, { force: true });
    throw new Error('the backup failed its integrity check');
  }
  return file;
}

// Keeps the first and the last backup of each of the most recent KEEP_DAYS days that have one.
// The first of a day is the one taken before that day's changes (or before an upgrade).
export function pruneBackups(dataDir) {
  const byDay = new Map();
  for (const name of listBackups(dataDir)) {
    const day = name.slice(4, 14);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(name);
  }
  const keep = new Set();
  for (const day of [...byDay.keys()].sort().slice(-KEEP_DAYS)) {
    keep.add(byDay.get(day)[0]);
    keep.add(byDay.get(day).at(-1));
  }
  for (const name of listBackups(dataDir)) {
    if (!keep.has(name)) rmSync(path.join(backupDir(dataDir), name));
  }
}
