// 浏览器内核管理：识别已安装内核、下载安装 fingerprint-chromium。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BROWSER_DIR } from './store.js';

// 内核下载源：adryfish/fingerprint-chromium（BSD-3-Clause）
const RELEASES = [
  {
    id: 'fp-chromium-148',
    name: 'Fingerprint Chromium 148',
    version: '148.0.7778.215',
    dmg: 'https://github.com/adryfish/fingerprint-chromium/releases/download/148.0.7778.215/ungoogled-chromium_148.0.7778.215-1.1_macos.dmg',
    dir: 'FingerprintChromium-148.app',
  },
  {
    id: 'fp-chromium-142',
    name: 'Fingerprint Chromium 142',
    version: '142.0.7444.175',
    dmg: 'https://github.com/adryfish/fingerprint-chromium/releases/download/142.0.7444.175/ungoogled-chromium_142.0.7444.175-1.1_macos.dmg',
    dir: 'FingerprintChromium-142.app',
  },
];

const SYSTEM_BROWSERS = [
  { id: 'system-chrome', name: 'Google Chrome（系统自带）', app: '/Applications/Google Chrome.app', bin: 'Google Chrome' },
  { id: 'system-edge', name: 'Microsoft Edge（系统自带）', app: '/Applications/Microsoft Edge.app', bin: 'Microsoft Edge' },
  { id: 'system-brave', name: 'Brave（系统自带）', app: '/Applications/Brave Browser.app', bin: 'Brave Browser' },
];

export const installState = { busy: false, id: '', step: '', percent: 0, error: '' };

function binInside(appPath) {
  const macos = path.join(appPath, 'Contents', 'MacOS');
  if (!fs.existsSync(macos)) return '';
  const files = fs.readdirSync(macos).filter((f) => !f.includes('.'));
  return files.length ? path.join(macos, files[0]) : '';
}

export function listEngines() {
  const out = [];

  for (const r of RELEASES) {
    const appPath = path.join(BROWSER_DIR, r.dir);
    const installed = fs.existsSync(appPath);
    out.push({
      id: r.id,
      name: r.name,
      version: r.version,
      kind: 'fingerprint',
      installed,
      path: installed ? binInside(appPath) : '',
      downloadable: true,
    });
  }

  for (const s of SYSTEM_BROWSERS) {
    if (!fs.existsSync(s.app)) continue;
    out.push({
      id: s.id,
      name: s.name,
      version: '',
      kind: 'system',
      installed: true,
      path: path.join(s.app, 'Contents', 'MacOS', s.bin),
      downloadable: false,
    });
  }

  return out;
}

export function resolveEngine(engineId) {
  const engines = listEngines();
  const wanted = engines.find((e) => e.id === engineId && e.installed);
  if (wanted) return wanted;
  // 没指定或指定的没装：优先挑指纹内核，退而求其次用系统浏览器
  return engines.find((e) => e.kind === 'fingerprint' && e.installed)
    || engines.find((e) => e.installed)
    || null;
}

/** 下载 dmg → 挂载 → 拷贝 → 去隔离标记。全程不需要 sudo。 */
export async function installEngine(id) {
  const rel = RELEASES.find((r) => r.id === id);
  if (!rel) throw new Error(`未知内核: ${id}`);
  if (installState.busy) throw new Error('已有下载任务在进行中');

  Object.assign(installState, { busy: true, id, step: '正在下载内核…', percent: 0, error: '' });

  const dmgPath = path.join(BROWSER_DIR, `${id}.dmg`);
  const appPath = path.join(BROWSER_DIR, rel.dir);
  const mountPoint = path.join('/tmp', `fpb-mount-${id}`);

  try {
    await run('curl', ['-L', '--retry', '3', '--fail', '-o', dmgPath, rel.dmg], (line) => {
      // curl 进度条形如: "  5  134M    5 7205k ..."，取第一列百分比
      const m = line.trim().match(/^(\d+)\s/);
      if (m) installState.percent = Math.min(95, Number(m[1]));
    });

    installState.step = '正在解包…';
    installState.percent = 96;
    fs.rmSync(mountPoint, { recursive: true, force: true });
    await run('hdiutil', ['attach', dmgPath, '-nobrowse', '-quiet', '-mountpoint', mountPoint]);

    const inner = fs.readdirSync(mountPoint).find((f) => f.endsWith('.app'));
    if (!inner) throw new Error('dmg 里没找到 .app');

    fs.rmSync(appPath, { recursive: true, force: true });
    await run('ditto', [path.join(mountPoint, inner), appPath]);
    await run('hdiutil', ['detach', mountPoint, '-quiet']).catch(() => {});

    installState.step = '正在解除 macOS 隔离标记…';
    installState.percent = 99;
    // 网上下载的 app 带 com.apple.quarantine，不清掉 Gatekeeper 会直接拦
    await run('xattr', ['-dr', 'com.apple.quarantine', appPath]).catch(() => {});

    fs.rmSync(dmgPath, { force: true });
    installState.step = '完成';
    installState.percent = 100;
    return { ok: true, path: binInside(appPath) };
  } catch (err) {
    installState.error = err.message;
    throw err;
  } finally {
    installState.busy = false;
  }
}

function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = '';
    const feed = (buf) => {
      const text = buf.toString();
      stderr += text;
      if (onLine) text.split(/[\r\n]/).forEach(onLine);
    };
    p.stderr.on('data', feed);
    p.stdout.on('data', (b) => onLine && b.toString().split(/[\r\n]/).forEach(onLine));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} 失败 (${code}): ${stderr.slice(-300)}`));
    });
  });
}
