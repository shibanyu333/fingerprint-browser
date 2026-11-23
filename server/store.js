import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PROFILE_DIR = path.join(ROOT, 'profiles');
export const BROWSER_DIR = path.join(ROOT, 'browsers');

const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULTS = {
  groups: [{ id: 'default', name: '未分组', createdAt: 0 }],
  proxies: [],
  profiles: [],
  settings: {
    port: 3131,
    defaultEngine: '',
    windowGrid: { cols: 4, width: 1024, height: 720, gapX: 24, gapY: 24, originX: 0, originY: 40 },
  },
};

let db = null;

function ensureDirs() {
  for (const d of [DATA_DIR, PROFILE_DIR, BROWSER_DIR]) fs.mkdirSync(d, { recursive: true });
}

export function load() {
  ensureDirs();
  if (db) return db;
  if (fs.existsSync(DB_FILE)) {
    try {
      db = { ...structuredClone(DEFAULTS), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
      db.settings = { ...DEFAULTS.settings, ...db.settings };
      db.settings.windowGrid = { ...DEFAULTS.settings.windowGrid, ...db.settings.windowGrid };
    } catch (err) {
      // A corrupt db would silently wipe every saved profile, so keep the bad file around.
      const backup = `${DB_FILE}.broken-${Date.now()}`;
      fs.writeFileSync(backup, fs.readFileSync(DB_FILE), { mode: 0o600, flag: 'wx' });
      console.error(`[store] db.json 解析失败，已备份到 ${backup}，本次以空库启动`);
      db = structuredClone(DEFAULTS);
    }
  } else {
    db = structuredClone(DEFAULTS);
    save();
  }
  return db;
}

export function save(next = db) {
  ensureDirs();
  const tmp = `${DB_FILE}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, DB_FILE);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function newId(prefix = 'p') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function isProfileId(id) {
  return typeof id === 'string' && /^[a-z0-9_-]+$/i.test(id);
}

export function profileDir(id) {
  if (!isProfileId(id)) throw new Error('环境 ID 格式无效');
  return path.join(PROFILE_DIR, id);
}

export function removeProfileDir(id) {
  fs.rmSync(profileDir(id), { recursive: true, force: true });
}

export async function profileDirSize(id) {
  const pending = [profileDir(id)];
  let total = 0;
  while (pending.length) {
    const entry = pending.pop();
    try {
      const stat = await fs.promises.lstat(entry);
      if (stat.isDirectory()) {
        for (const child of await fs.promises.readdir(entry)) {
          pending.push(path.join(entry, child));
        }
      } else if (stat.isFile()) {
        total += stat.size;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return total;
}
