import net from 'node:net';
import fs from 'node:fs';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { profileDir, PROFILE_DIR, load, save } from './store.js';
import { Relay, normalizeUpstream } from './proxy-relay.js';
import { resolveEngine } from './engines.js';
import { uaPreview, localeForCountry } from './fingerprint.js';
import { checkProxy } from './ipcheck.js';
import { attachPatches } from './cdp-stealth.js';
import { once } from 'node:events';

/** profileId -> 运行态 */
export const running = new Map();
const starting = new Map();
const closing = new Map();

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let screenCache = null;
async function screenSize() {
  if (screenCache) return screenCache;
  screenCache = await new Promise((resolve) => {
    execFile('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ w: 1728, h: 1080 });
      const nums = String(stdout).split(',').map((n) => Number(n.trim()));
      resolve(nums.length === 4 && nums[2] ? { w: nums[2], h: nums[3] } : { w: 1728, h: 1080 });
    });
  });
  return screenCache;
}

/** 批量打开时把窗口摆成网格，不然十几个窗口全叠在一起没法用 */
async function gridPosition(index, grid) {
  const screen = await screenSize();
  const cols = Math.max(1, grid.cols);
  const rows = Math.max(1, Math.floor((screen.h - grid.originY) / (grid.height + grid.gapY)) || 1);
  const slot = index % (cols * rows);
  const col = slot % cols;
  const row = Math.floor(slot / cols);
  return {
    x: Math.round(grid.originX + col * (grid.width + grid.gapX)),
    y: Math.round(grid.originY + row * (grid.height + grid.gapY)),
    w: grid.width,
    h: grid.height,
  };
}

function buildArgs(profile, engine, ctx) {
  const fp = profile.fingerprint;
  const args = [
    `--user-data-dir=${profileDir(profile.id)}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    // 不加这个，macOS 每开一个环境都会弹钥匙串授权框
    '--use-mock-keychain',
    `--window-size=${ctx.win.w},${ctx.win.h}`,
    `--window-position=${ctx.win.x},${ctx.win.y}`,
  ];

  if (ctx.relayPort) args.push(`--proxy-server=http://127.0.0.1:${ctx.relayPort}`);
  if (ctx.cdpPort) args.push(`--remote-debugging-port=${ctx.cdpPort}`);

  if (engine.kind === 'fingerprint') {
    // 源码级指纹改造：种子决定 canvas / webgl / 音频 / 字体 / clientRects 噪声
    args.push(`--fingerprint=${fp.seed}`);
    args.push(`--fingerprint-platform=${fp.platform}`);
    if (fp.platformVersion) args.push(`--fingerprint-platform-version=${fp.platformVersion}`);
    args.push(`--fingerprint-brand=${fp.brand}`);
    if (fp.brandVersion) args.push(`--fingerprint-brand-version=${fp.brandVersion}`);
    if (fp.hardwareConcurrency) args.push(`--fingerprint-hardware-concurrency=${fp.hardwareConcurrency}`);
    if (fp.disableSpoofing?.length) args.push(`--disable-spoofing=${fp.disableSpoofing.join(',')}`);
    if (fp.webrtc === 'disabled') args.push('--disable-non-proxied-udp');
  } else {
    // 系统浏览器：只能做到这个程度，深度补丁靠 CDP 注入
    args.push(`--user-agent=${uaPreview(fp)}`);
    args.push('--disable-blink-features=AutomationControlled');
    if (fp.webrtc === 'disabled') args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  }

  // 内核改了 WebGL 却没管 WebGPU：WebGL 报 "NVIDIA RTX 4060 / Direct3D11"，
  // WebGPU 却老实报 {vendor:"apple", architecture:"metal-3"} —— 自相矛盾，一查一个准。
  // 没有参数能改 WebGPU 的适配器信息，只能关掉适配器：navigator.gpu 还在，但
  // requestAdapter() 返回 null。这在真实世界很常见（老显卡、虚拟机、驱动不支持），
  // 比暴露 Apple GPU 安全得多。伪装成 macOS 时不用关 —— 那时报 apple 才是对的。
  if (fp.platform !== 'macos') args.push('--disable-features=WebGPUService');

  args.push(`--lang=${fp.lang}`);
  args.push(`--accept-lang=${fp.acceptLang}`);
  args.push(`--timezone=${fp.timezone}`);

  // 注意：ICU 默认 locale 不由 --lang 决定，见下面的 applyAppleLanguages()

  if (fp.customArgs) {
    for (const a of String(fp.customArgs).split(/\s+/).filter(Boolean)) args.push(a);
  }
  if (profile.startUrl) args.push('--', profile.startUrl);
  return args;
}

/**
 * 修掉 macOS 上的 Intl 语言泄露。
 *
 * `--lang=en-US` 只改界面语言和 navigator.language，管不到 ICU 的默认 locale：
 * 中文系统上 Intl.DateTimeFormat().resolvedOptions().locale 仍然返回 zh-CN，
 * 月份名、货币名、时区名全渲染成中文 —— navigator.language 说 en-US、Intl 说 zh-CN，
 * 自相矛盾，BrowserScan 的 "Language mismatch" 扣分就是这个，CreepJS 也会记一笔。
 *
 * 实测三种办法：LANG/LC_ALL 环境变量无效；命令行传 -AppleLanguages 有效但会被 Chromium
 * 当成网址多开一个垃圾标签页；只有先写 NSUserDefaults 域再启动才既有效又干净。
 *
 * 注意：最终生效的是 Chromium 自带的界面语言包。en-US 有对应的 pak，Intl 就精确到 en-US；
 * 德语只有 de.pak，所以填 de-DE 时 Intl 默认值是 de —— 真实德国电脑上也是这个结果，不是破绽。
 *
 * 只对我们自己打包的内核这么做 —— 系统 Chrome 的偏好域是用户自己的，不能碰。
 */
const langLock = { chain: Promise.resolve() };

function setAppleLanguages(bundleId, langs) {
  return new Promise((resolve) => {
    execFile('defaults', ['write', bundleId, 'AppleLanguages', '-array', ...langs], { timeout: 5000 }, (err) => {
      if (err) console.error(`[locale] 写入 ${bundleId} 失败，Intl 可能泄露系统语言: ${err.message}`);
      resolve();
    });
  });
}

function bundleIdOf(binPath) {
  const m = binPath.match(/^(.*\.app)\/Contents\/MacOS\//);
  if (!m) return '';
  try {
    return execFileSync('defaults', ['read', `${m[1]}/Contents/Info`, 'CFBundleIdentifier'], { timeout: 5000 })
      .toString().trim();
  } catch {
    return '';
  }
}

/**
 * 偏好域是按 bundle id 全局共享的，而每个 Chromium 进程在启动瞬间读一次。
 * 所以「写入 → 启动 → 等它读完」这三步必须串起来，否则并发打开两个不同语言的
 * 环境时，后写的值会串到先启动的进程里。
 */
function withAppleLanguages(engine, fp, spawnFn) {
  if (engine.kind !== 'fingerprint') return spawnFn();
  const bundleId = bundleIdOf(engine.path);
  if (!bundleId) return spawnFn();

  const langs = String(fp.acceptLang || fp.lang)
    .split(',')
    .map((s) => s.trim().split(';')[0])
    .filter(Boolean);
  if (!langs.length) return spawnFn();

  const run = langLock.chain.then(async () => {
    await setAppleLanguages(bundleId, langs);
    const result = await spawnFn();
    // 给子进程读完 NSUserDefaults 的时间，之后才允许下一个环境改写这个域
    await new Promise((r) => setTimeout(r, 700));
    return result;
  });
  langLock.chain = run.then(() => {}, () => {});
  return run;
}

export function isRunning(id) {
  const r = running.get(id);
  if (!r) return false;
  try {
    process.kill(r.pid, 0);
    return true;
  } catch {
    r.relay?.close();
    r.detachStealth?.();
    running.delete(id);
    return false;
  }
}

/**
 * 打开一个环境。
 * 默认会先检测代理 —— 代理挂了还硬开，等于用真实 IP 登店铺，这是防关联里最致命的事故，
 * 所以除非显式 force，否则检测不过直接拒绝启动。
 */
export async function launchProfile(profile, opts = {}) {
  if (closing.has(profile.id)) throw new Error('该环境正在关闭');
  if (starting.has(profile.id)) throw new Error('该环境正在启动');
  if (isRunning(profile.id)) throw new Error('该环境已经在运行中');

  const pending = startProfile(profile, opts);
  starting.set(profile.id, pending);
  try {
    return await pending;
  } finally {
    starting.delete(profile.id);
  }
}

async function startProfile(profile, opts) {
  const db = load();
  const engine = resolveEngine(opts.engineId || profile.engineId || db.settings.defaultEngine);
  if (!engine) throw new Error('没有可用的浏览器内核，请先到「内核管理」下载');

  const upstream = normalizeUpstream(profile.proxy);
  const fp = { ...profile.fingerprint };
  let ipInfo = null;

  if (upstream) {
    try {
      ipInfo = await checkProxy(profile.proxy);
    } catch (err) {
      if (!opts.force) {
        throw new Error(`代理不可用，已阻止启动（避免用真实 IP 登录）：${err.message}`);
      }
    }
    if (ipInfo && fp.autoLocale) {
      const loc = localeForCountry(ipInfo.countryCode);
      if (loc) {
        fp.lang = loc.lang;
        fp.acceptLang = loc.accept;
      }
      // 时区用 IP 真实时区，比国家默认值更准
      if (ipInfo.timezone) fp.timezone = ipInfo.timezone;
    }
  }

  // 屏幕分辨率伪装要靠 CDP，所以开着它就必须有调试端口。
  // 实测开着调试端口并不会被识破：BrowserScan 判 Bot Detection=No，
  // CreepJS 报 0% stealth，Pixelscan 报 no automated behavior —— 内核做过 CDP 反检测。
  const needScreenPatch = engine.kind === 'fingerprint' && fp.spoofScreen !== false && fp.screen?.w;
  const cdpPort = profile.automation || engine.kind === 'system' || needScreenPatch ? await freePort() : 0;
  const grid = { ...db.settings.windowGrid };
  if (profile.window?.width) {
    grid.width = profile.window.width;
    grid.height = profile.window.height;
  }
  const win = await gridPosition(opts.index || 0, grid);

  fs.mkdirSync(profileDir(profile.id), { recursive: true });
  const relay = upstream ? new Relay(profile.proxy, profile.name) : null;
  let relayPort = 0;
  let proc;
  try {
    if (relay) relayPort = await relay.listen();
    const args = buildArgs({ ...profile, fingerprint: fp }, engine, { relayPort, cdpPort, win });
    proc = await withAppleLanguages(engine, fp, async () => {
      const child = spawn(engine.path, args, { stdio: 'ignore', detached: false });
      await once(child, 'spawn');
      return child;
    });
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error('浏览器进程启动后立即退出');
  } catch (err) {
    relay?.close();
    throw err;
  }

  const state = {
    pid: proc.pid,
    proc,
    relay,
    relayPort,
    cdpPort,
    engineId: engine.id,
    engineName: engine.name,
    startedAt: Date.now(),
    ipInfo,
    detachStealth: null,
  };
  running.set(profile.id, state);

  proc.on('exit', () => {
    const cur = running.get(profile.id);
    if (cur && cur.pid === proc.pid) {
      cur.relay?.close();
      cur.detachStealth?.();
      running.delete(profile.id);
    }
  });
  proc.on('error', () => {
    relay?.close();
    running.delete(profile.id);
  });

  if (cdpPort && (engine.kind === 'system' || needScreenPatch)) {
    // 系统浏览器要全套补丁，指纹内核只需要补屏幕分辨率
    const mode = engine.kind === 'system' ? 'full' : 'screen';
    attachPatches(cdpPort, fp, uaPreview(fp), mode)
      .then((detach) => {
        if (running.get(profile.id) === state) state.detachStealth = detach;
        else detach();
      })
      .catch((err) => console.error(`[patch] ${profile.name}: ${err.message}`));
  }

  // 记录一下最近一次的运行信息，列表里能直接看到出口 IP
  const stored = db.profiles.find((p) => p.id === profile.id);
  if (stored) {
    stored.lastRunAt = Date.now();
    stored.lastIpInfo = ipInfo;
    stored.appliedFingerprint = { lang: fp.lang, timezone: fp.timezone };
    try {
      save();
    } catch (err) {
      console.error('[launcher] 无法保存最近运行记录', err);
    }
  }

  return { pid: proc.pid, cdpPort, relayPort, engine: engine.name, ipInfo };
}

export async function closeProfile(id) {
  if (closing.has(id)) return closing.get(id);
  const pending = stopProfile(id);
  closing.set(id, pending);
  try {
    return await pending;
  } finally {
    closing.delete(id);
  }
}

async function stopProfile(id) {
  await starting.get(id)?.catch(() => {});
  const r = running.get(id);
  if (!r) return { ok: false, message: '环境未在运行' };

  try {
    process.kill(r.pid, 'SIGTERM');
  } catch {
    /* 进程已经没了 */
  }

  // 给 Chromium 一点时间把 cookie / localStorage 落盘，硬杀会丢登录态
  await new Promise((resolve) => setTimeout(resolve, 1500));
  try {
    if (running.get(id) === r) process.kill(r.pid, 'SIGKILL');
  } catch {
    /* 已正常退出 */
  }

  r.relay?.close();
  r.detachStealth?.();
  running.delete(id);
  return { ok: true };
}

export async function closeAll() {
  const ids = new Set([...running.keys(), ...starting.keys(), ...closing.keys()]);
  const results = await Promise.all([...ids].map(closeProfile));
  return results.filter((result) => result.ok).length;
}

/**
 * 管理端重启后，之前开着的浏览器还活着但没人管了。
 * 用 user-data-dir 把它们认领回来，避免「明明开着却显示未运行」。
 */
export function adoptOrphans() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(0);
      let adopted = 0;
      for (const line of String(stdout).split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!m) continue;
        const [, pid, cmd] = m;
        // 只认主进程：渲染进程也带 user-data-dir，但它们有 --type=
        if (cmd.includes('--type=')) continue;
        const dirMatch = cmd.match(new RegExp(`--user-data-dir=${escapeRe(PROFILE_DIR)}/([\\w-]+)`));
        if (!dirMatch) continue;
        const profileId = dirMatch[1];
        if (running.has(profileId)) continue;
        running.set(profileId, {
          pid: Number(pid),
          proc: null,
          relay: null,
          relayPort: 0,
          cdpPort: 0,
          engineId: '',
          engineName: '（重启前已打开）',
          startedAt: 0,
          ipInfo: null,
          adopted: true,
        });
        adopted += 1;
      }
      resolve(adopted);
    });
  });
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function runtimeInfo(id) {
  const r = running.get(id);
  if (!r) return null;
  return {
    pid: r.pid,
    startedAt: r.startedAt,
    cdpPort: r.cdpPort,
    engineName: r.engineName,
    adopted: !!r.adopted,
    traffic: r.relay ? { up: r.relay.stats.up, down: r.relay.stats.down, errors: r.relay.stats.errors, lastError: r.relay.stats.lastError } : null,
  };
}
