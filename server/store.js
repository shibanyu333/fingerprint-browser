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
      fs.copyFileSync(DB_FILE, backup);
      console.error(`[store] db.json 解析失败，已备份到 ${backup}，本次以空库启动`);
      db = structuredClone(DEFAULTS);
    }
  } else {
    db = structuredClone(DEFAULTS);
    save();
  }
  return db;
}

export function save() {
  ensureDirs();
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export function newId(prefix = 'p') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function profileDir(id) {
  return path.join(PROFILE_DIR, id);
}

export function removeProfileDir(id) {
  const dir = profileDir(id);
  if (dir.startsWith(PROFILE_DIR) && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function profileDirSize(id) {
  const dir = profileDir(id);
  let total = 0;
  const walk = (p) => {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* file vanished mid-walk */
        }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return total;
}
