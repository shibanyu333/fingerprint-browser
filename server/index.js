import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { load, save, newId, ROOT, isProfileId, removeProfileDir, profileDirSize } from './store.js';
import { buildFingerprint, randomSeed, uaPreview, platformOptions, brandOptions, SCREEN_PRESETS, LOCALE_BY_COUNTRY } from './fingerprint.js';
import { listEngines, installEngine, installState } from './engines.js';
import { checkProxy } from './ipcheck.js';
import { launchProfile, closeProfile, closeAll, isRunning, runtimeInfo, adoptOrphans, running } from './launcher.js';

const db = load();
const app = express();
app.disable('x-powered-by');
app.set('query parser', 'simple');

const ok = (res, data = {}) => res.json({ ok: true, ...data });
const fail = (res, err, code = 400) => res.status(code).json({ ok: false, error: String(err?.message || err) });
let ready = false;

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  const host = req.get('Host')?.toLowerCase();
  if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host || '')) {
    return fail(res, '只接受本机管理端地址', 403);
  }
  next();
});

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const origin = `http://${req.get('Host').toLowerCase()}`;
  const requestOrigin = req.get('Origin');
  const referer = req.get('Referer');
  const site = req.get('Sec-Fetch-Site');
  if ((requestOrigin && requestOrigin !== origin)
    || (referer && !referer.startsWith(`${origin}/`))
    || (site && site !== 'same-origin' && site !== 'none')) {
    return fail(res, '管理 API 只接受同源网页或本机客户端请求', 403);
  }
  if (!ready) return fail(res, '正在初始化管理端', 503);
  next();
});

app.get('/api/health', (_req, res) => ok(res, { service: 'fingerprint-browser' }));
app.use('/api', express.json({ limit: '20mb' }));
app.use(express.static(path.join(ROOT, 'web')));

/** 环境可以直接写死代理，也可以引用代理池里的条目 */
export function resolveProxy(profile) {
  const p = profile.proxy || {};
  if (p.mode === 'pool' && p.poolId) {
    const entry = db.proxies.find((x) => x.id === p.poolId);
    if (!entry) return null;
    return { type: entry.type, host: entry.host, port: entry.port, username: entry.username, password: entry.password };
  }
  if (p.mode === 'custom' && p.host) {
    return { type: p.type || 'socks5', host: p.host, port: p.port, username: p.username, password: p.password };
  }
  return null;
}

function withRuntime(profile) {
  const proxy = resolveProxy(profile);
  return {
    ...profile,
    running: isRunning(profile.id),
    runtime: runtimeInfo(profile.id),
    ua: uaPreview(profile.fingerprint),
    proxyLabel: proxy ? `${proxy.type}://${proxy.host}:${proxy.port}`
      : hasProxyBinding(profile) ? '代理配置缺失，请重新绑定' : '不使用代理（直连本机 IP）',
    proxyResolved: !!proxy,
  };
}

function hasProxyBinding(profile) {
  return profile.proxy?.mode === 'pool' || profile.proxy?.mode === 'custom';
}

const deleting = new Set();

function launchConfiguredProfile(profile, opts) {
  if (deleting.has(profile.id)) throw new Error('该环境正在删除');
  const proxy = resolveProxy(profile);
  if (hasProxyBinding(profile)) {
    if (!proxy) throw new Error('代理配置缺失，请重新绑定代理');
    const port = Number(proxy.port);
    if (!['socks', 'socks4', 'socks5', 'http', 'https'].includes(String(proxy.type).toLowerCase())
      || !String(proxy.host || '').trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('绑定的代理配置无效，请检查类型、地址和端口');
    }
  }
  return launchProfile({ ...profile, proxy }, opts);
}

// ---------------------------------------------------------------- 读取状态

app.get('/api/state', (req, res) => {
  ok(res, {
    profiles: db.profiles.map(withRuntime),
    groups: db.groups,
    proxies: db.proxies,
    settings: db.settings,
    engines: listEngines(),
    runningCount: [...running.keys()].filter(isRunning).length,
  });
});

app.get('/api/options', (_req, res) => {
  ok(res, {
    platforms: platformOptions(),
    brands: brandOptions(),
    screens: SCREEN_PRESETS,
    countries: Object.entries(LOCALE_BY_COUNTRY).map(([code, v]) => ({ code, ...v })),
    timezones: [...new Set(Object.values(LOCALE_BY_COUNTRY).map((v) => v.tz))].sort(),
  });
});

app.get('/api/profiles/:id/size', async (req, res, next) => {
  if (!isProfileId(req.params.id)) return fail(res, '环境 ID 格式无效');
  try {
    ok(res, { bytes: await profileDirSize(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- 环境增删改

app.post('/api/profiles', (req, res) => {
  try {
    const body = req.body || {};
    const count = Math.min(Math.max(Number(body.count) || 1, 1), 100);
    const created = [];

    for (let i = 0; i < count; i++) {
      const id = newId('env');
      const name = count > 1 ? `${body.name || '环境'}-${String(i + 1).padStart(2, '0')}` : body.name || '新环境';
      const profile = {
        id,
        name,
        group: body.group || 'default',
        tags: body.tags || [],
        shop: body.shop || '',
        account: body.account || '',
        notes: body.notes || '',
        engineId: body.engineId || '',
        startUrl: body.startUrl || '',
        automation: !!body.automation,
        // 批量创建时每个环境都要有自己的种子，否则等于开了 N 个一模一样的浏览器
        proxy: body.proxy || { mode: 'none' },
        fingerprint: buildFingerprint({ ...(body.fingerprint || {}), seed: count > 1 ? randomSeed() : body.fingerprint?.seed }),
        window: body.window || {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastRunAt: 0,
        lastIpInfo: null,
      };
      db.profiles.push(profile);
      created.push(profile);
    }
    save();
    ok(res, { created: created.map(withRuntime) });
  } catch (err) {
    fail(res, err);
  }
});

app.put('/api/profiles/:id', (req, res) => {
  const p = db.profiles.find((x) => x.id === req.params.id);
  if (!p) return fail(res, '环境不存在', 404);
  const body = req.body || {};
  Object.assign(p, {
    name: body.name ?? p.name,
    group: body.group ?? p.group,
    tags: body.tags ?? p.tags,
    shop: body.shop ?? p.shop,
    account: body.account ?? p.account,
    notes: body.notes ?? p.notes,
    engineId: body.engineId ?? p.engineId,
    startUrl: body.startUrl ?? p.startUrl,
    automation: body.automation ?? p.automation,
    proxy: body.proxy ?? p.proxy,
    window: body.window ?? p.window,
    updatedAt: Date.now(),
  });
  if (body.fingerprint) p.fingerprint = buildFingerprint({ ...p.fingerprint, ...body.fingerprint });
  save();
  ok(res, { profile: withRuntime(p) });
});

app.post('/api/profiles/:id/clone', (req, res) => {
  const src = db.profiles.find((x) => x.id === req.params.id);
  if (!src) return fail(res, '环境不存在', 404);
  const copy = structuredClone(src);
  copy.id = newId('env');
  copy.name = `${src.name}-副本`;
  // 换新种子：复制环境是为了省配置，不是为了造两个同指纹的浏览器
  copy.fingerprint = buildFingerprint({ ...src.fingerprint, seed: randomSeed() });
  copy.createdAt = Date.now();
  copy.lastRunAt = 0;
  copy.lastIpInfo = null;
  db.profiles.push(copy);
  save();
  ok(res, { profile: withRuntime(copy) });
});

app.post('/api/profiles/:id/reseed', (req, res) => {
  const p = db.profiles.find((x) => x.id === req.params.id);
  if (!p) return fail(res, '环境不存在', 404);
  p.fingerprint = buildFingerprint({ ...p.fingerprint, seed: randomSeed(), platform: req.body?.platform || p.fingerprint.platform });
  p.updatedAt = Date.now();
  save();
  ok(res, { profile: withRuntime(p) });
});

app.delete('/api/profiles/:id', async (req, res, next) => {
  const { id } = req.params;
  if (!isProfileId(id)) return fail(res, '环境 ID 格式无效');
  if (!db.profiles.some((p) => p.id === id)) return fail(res, '环境不存在', 404);
  if (deleting.has(id)) return fail(res, '该环境正在删除', 409);
  deleting.add(id);
  try {
    await closeProfile(id);
    const profiles = db.profiles.filter((p) => p.id !== id);
    if (req.query.purge === '1') removeProfileDir(id);
    save({ ...db, profiles });
    db.profiles = profiles;
    ok(res);
  } catch (err) {
    next(err);
  } finally {
    deleting.delete(id);
  }
});

// ---------------------------------------------------------------- 打开 / 关闭

app.post('/api/profiles/:id/launch', async (req, res) => {
  const p = db.profiles.find((x) => x.id === req.params.id);
  if (!p) return fail(res, '环境不存在', 404);
  try {
    const info = await launchConfiguredProfile(p, { force: !!req.body?.force, index: Number(req.body?.index) || 0 });
    ok(res, { info });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/profiles/:id/close', async (req, res) => {
  try {
    ok(res, await closeProfile(req.params.id));
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/batch/launch', async (req, res) => {
  const ids = req.body?.ids || [];
  if (!Array.isArray(ids)) return fail(res, '环境 ID 必须为数组');
  const force = !!req.body?.force;
  const results = [];
  let slot = 0;
  for (const id of ids) {
    const p = db.profiles.find((x) => x.id === id);
    if (!p) continue;
    if (isRunning(id)) {
      results.push({ id, name: p.name, ok: false, error: '已在运行' });
      continue;
    }
    try {
      const info = await launchConfiguredProfile(p, { force, index: slot });
      results.push({ id, name: p.name, ok: true, info });
      slot += 1;
      // 错开一点，避免十几个 Chromium 同时冷启动把机器打满
      await new Promise((r) => setTimeout(r, 900));
    } catch (err) {
      results.push({ id, name: p.name, ok: false, error: err.message });
    }
  }
  ok(res, { results });
});

app.post('/api/batch/close', async (req, res) => {
  const ids = req.body?.ids || [];
  if (!Array.isArray(ids)) return fail(res, '环境 ID 必须为数组');
  await Promise.all([...new Set(ids)].map((id) => closeProfile(id).catch(() => {})));
  ok(res);
});

app.post('/api/batch/close-all', async (_req, res) => {
  ok(res, { closed: await closeAll() });
});

// ---------------------------------------------------------------- 代理

app.post('/api/profiles/:id/check', async (req, res) => {
  const p = db.profiles.find((x) => x.id === req.params.id);
  if (!p) return fail(res, '环境不存在', 404);
  const proxy = resolveProxy(p);
  if (!proxy) return fail(res, '该环境没有配置代理');
  try {
    const info = await checkProxy(proxy);
    p.lastIpInfo = info;
    save();
    ok(res, { info });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/proxies/check', async (req, res) => {
  try {
    ok(res, { info: await checkProxy(req.body) });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/proxies', (req, res) => {
  const b = req.body || {};
  if (!b.host || !b.port) return fail(res, '代理地址和端口必填');
  const entry = {
    id: newId('px'),
    label: b.label || `${b.host}:${b.port}`,
    type: b.type || 'socks5',
    host: String(b.host).trim(),
    port: Number(b.port),
    username: b.username || '',
    password: b.password || '',
    note: b.note || '',
    lastCheck: null,
    createdAt: Date.now(),
  };
  db.proxies.push(entry);
  save();
  ok(res, { proxy: entry });
});

app.put('/api/proxies/:id', (req, res) => {
  const e = db.proxies.find((x) => x.id === req.params.id);
  if (!e) return fail(res, '代理不存在', 404);
  Object.assign(e, req.body || {}, { id: e.id });
  e.port = Number(e.port);
  save();
  ok(res, { proxy: e });
});

app.delete('/api/proxies/:id', (req, res) => {
  const idx = db.proxies.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return fail(res, '代理不存在', 404);
  const inUse = db.profiles.filter((p) => p.proxy?.mode === 'pool' && p.proxy.poolId === req.params.id);
  if (inUse.length && req.query.force !== '1') {
    return fail(res, `有 ${inUse.length} 个环境正在用这条代理：${inUse.map((p) => p.name).join('、')}`, 409);
  }
  db.proxies.splice(idx, 1);
  save();
  ok(res);
});

/** 批量粘贴导入，支持 host:port / host:port:user:pass / type://user:pass@host:port */
app.post('/api/proxies/import', (req, res) => {
  const text = String(req.body?.text || '');
  const defType = req.body?.type || 'socks5';
  const added = [];
  const errors = [];

  let lineNumber = 0;
  for (const rawLine of text.split('\n')) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      added.push(parseProxyLine(line, defType));
    } catch (err) {
      errors.push(`第 ${lineNumber} 行：${err.message}`);
    }
  }
  for (const a of added) {
    a.id = newId('px');
    a.createdAt = Date.now();
    a.lastCheck = null;
    db.proxies.push(a);
  }
  save();
  ok(res, { added: added.length, errors, proxies: db.proxies });
});

function parseProxyLine(line, defType) {
  let type = defType;
  let rest = line;

  const schemeMatch = rest.match(/^(socks5|socks4|http|https):\/\/(.*)$/i);
  if (schemeMatch) {
    type = schemeMatch[1].toLowerCase();
    rest = schemeMatch[2];
  }

  let username = '';
  let password = '';
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const cred = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const ci = cred.indexOf(':');
    username = ci === -1 ? cred : cred.slice(0, ci);
    password = ci === -1 ? '' : cred.slice(ci + 1);
  }

  const parts = rest.split(':');
  if (parts.length < 2) throw new Error('格式不认识，至少要有 host:port');
  const host = parts[0];
  const port = Number(parts[1]);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('地址或端口不合法');
  // host:port:user:pass 这种写法
  if (parts.length >= 4 && !username) {
    username = parts[2];
    password = parts.slice(3).join(':');
  }

  return { label: `${host}:${port}`, type, host, port, username, password, note: '' };
}

// ---------------------------------------------------------------- 分组

app.post('/api/groups', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return fail(res, '分组名不能为空');
  const g = { id: newId('g'), name, createdAt: Date.now() };
  db.groups.push(g);
  save();
  ok(res, { group: g });
});

app.put('/api/groups/:id', (req, res) => {
  const g = db.groups.find((x) => x.id === req.params.id);
  if (!g) return fail(res, '分组不存在', 404);
  g.name = String(req.body?.name || g.name).trim();
  save();
  ok(res, { group: g });
});

app.delete('/api/groups/:id', (req, res) => {
  if (req.params.id === 'default') return fail(res, '默认分组不能删除');
  const idx = db.groups.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return fail(res, '分组不存在', 404);
  for (const p of db.profiles) if (p.group === req.params.id) p.group = 'default';
  db.groups.splice(idx, 1);
  save();
  ok(res);
});

app.post('/api/batch/move-group', (req, res) => {
  const { ids = [], group = 'default' } = req.body || {};
  if (!Array.isArray(ids)) return fail(res, '环境 ID 必须为数组');
  if (!db.groups.some((entry) => entry.id === group)) return fail(res, '分组不存在', 404);
  const selected = new Set(ids);
  for (const p of db.profiles) if (selected.has(p.id)) p.group = group;
  save();
  ok(res);
});

// ---------------------------------------------------------------- 内核

app.get('/api/engines', (_req, res) => ok(res, { engines: listEngines(), installState }));

app.post('/api/engines/:id/install', (req, res) => {
  installEngine(req.params.id).catch(() => {});
  ok(res, { started: true });
});

app.get('/api/engines/install-state', (_req, res) => ok(res, { installState }));

// ---------------------------------------------------------------- 设置 / 备份

app.put('/api/settings', (req, res) => {
  Object.assign(db.settings, req.body || {});
  save();
  ok(res, { settings: db.settings });
});

app.get('/api/export', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="fpb-backup.json"');
  res.json({ version: 1, exportedAt: Date.now(), groups: db.groups, proxies: db.proxies, profiles: db.profiles });
});

app.post('/api/import', (req, res) => {
  const data = req.body || {};
  if (!Array.isArray(data.profiles)) return fail(res, '备份文件格式不对');
  const entries = { groups: data.groups ?? [], proxies: data.proxies ?? [], profiles: data.profiles };
  for (const [key, records] of Object.entries(entries)) {
    if (!Array.isArray(records) || records.some((entry) => !entry || !isProfileId(entry.id))) {
      return fail(res, `备份中的 ${key} 记录或 ID 格式无效`);
    }
  }
  if (entries.profiles.some((p) => typeof p.name !== 'string'
    || !p.fingerprint || typeof p.fingerprint !== 'object' || Array.isArray(p.fingerprint))) {
    return fail(res, '环境记录缺少名称或指纹配置');
  }

  const groups = new Map(db.groups.map((g) => [g.id, g]));
  const proxies = new Map(db.proxies.map((p) => [p.id, p]));
  const profiles = new Map(db.profiles.map((p) => [p.id, p]));
  for (const g of entries.groups) if (!groups.has(g.id)) groups.set(g.id, g);
  for (const px of entries.proxies) if (!proxies.has(px.id)) proxies.set(px.id, px);
  for (const p of entries.profiles) {
    const profile = profiles.has(p.id) || deleting.has(p.id)
      ? { ...p, id: newId('env'), name: `${p.name}-导入` }
      : p;
    profiles.set(profile.id, profile);
  }
  const updated = { groups: [...groups.values()], proxies: [...proxies.values()], profiles: [...profiles.values()] };
  save({ ...db, ...updated });
  Object.assign(db, updated);
  ok(res, { added: entries.profiles.length });
});

// ---------------------------------------------------------------- 自动化本地接口
// 给 Playwright / Puppeteer 脚本用：拿到 CDP 地址直接接管浏览器。

/** 自动化接口统一支持用环境 ID 或名字定位 */
const findProfile = (idOrName) => db.profiles.find((x) => x.id === idOrName || x.name === idOrName) || null;

app.head(['/api/v1/browser/start', '/api/v1/browser/stop'], (_req, res) => {
  res.set('Allow', 'GET').sendStatus(405);
});

app.get('/api/v1/browser/start', async (req, res) => {
  const p = findProfile(req.query.profile_id || req.query.user_id);
  if (!p) return res.json({ code: -1, msg: '环境不存在' });
  try {
    if (isRunning(p.id)) {
      const rt = runtimeInfo(p.id);
      return res.json({ code: 0, msg: 'already running', data: cdpPayload(rt.cdpPort) });
    }
    const info = await launchConfiguredProfile({ ...p, automation: true }, { force: req.query.force === '1' });
    res.json({ code: 0, msg: 'success', data: { ...cdpPayload(info.cdpPort), ip: info.ipInfo?.ip || '' } });
  } catch (err) {
    res.json({ code: -1, msg: err.message });
  }
});

app.get('/api/v1/browser/stop', async (req, res) => {
  const p = findProfile(req.query.profile_id || req.query.user_id);
  if (p) await closeProfile(p.id).catch(() => {});
  res.json({ code: 0, msg: 'success' });
});

app.get('/api/v1/browser/active', (req, res) => {
  const p = findProfile(req.query.profile_id || req.query.user_id);
  const rt = p ? runtimeInfo(p.id) : null;
  res.json({ code: 0, data: { status: rt ? 'Active' : 'Inactive', ...(rt ? cdpPayload(rt.cdpPort) : {}) } });
});

app.get('/api/v1/user/list', (_req, res) => {
  res.json({
    code: 0,
    data: {
      list: db.profiles.map((p) => ({ user_id: p.id, name: p.name, group_id: p.group, remark: p.notes })),
    },
  });
});

function cdpPayload(port) {
  return {
    debug_port: String(port || ''),
    ws: {
      puppeteer: port ? `http://127.0.0.1:${port}` : '',
      selenium: port ? `127.0.0.1:${port}` : '',
    },
  };
}

// ----------------------------------------------------------------

app.use((err, _req, res, _next) => {
  if (err.status === 400) return fail(res, '请求 JSON 格式无效');
  if (err.status === 413) return fail(res, '请求内容太大', 413);
  console.error(err);
  fail(res, '管理端处理请求失败', 500);
});

const PORT = Number(process.env.PORT) || db.settings.port || 3131;

const adopted = await adoptOrphans();
ready = true;
const server = app.listen(PORT, '127.0.0.1', () => {
  const engines = listEngines().filter((e) => e.installed);
  console.log('');
  console.log('  指纹浏览器管理端已启动');
  console.log(`  →  http://127.0.0.1:${PORT}`);
  console.log('');
  console.log(`  环境 ${db.profiles.length} 个 | 代理 ${db.proxies.length} 条 | 可用内核 ${engines.length} 个`);
  if (adopted) console.log(`  接管了 ${adopted} 个重启前已打开的浏览器`);
  if (!engines.some((e) => e.kind === 'fingerprint')) {
    console.log('  ⚠️  还没装指纹内核，先到「内核管理」下载 Fingerprint Chromium');
  }
  console.log('');
});

async function shutdown() {
  ready = false;
  console.log('\n正在关闭所有环境…');
  // 中继一断浏览器就没网了，与其让它裸奔不如一起关掉
  await closeAll().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (!fs.existsSync(path.join(ROOT, 'web', 'index.html'))) {
  console.error('web/index.html 缺失，界面无法加载');
}
