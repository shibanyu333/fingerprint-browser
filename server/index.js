import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { load, save, newId, ROOT, removeProfileDir, profileDirSize } from './store.js';
import { buildFingerprint, randomSeed, uaPreview, platformOptions, brandOptions, SCREEN_PRESETS, LOCALE_BY_COUNTRY } from './fingerprint.js';
import { listEngines, installEngine, installState, resolveEngine } from './engines.js';
import { checkProxy } from './ipcheck.js';
import { launchProfile, closeProfile, closeAll, isRunning, runtimeInfo, adoptOrphans, running } from './launcher.js';

const db = load();
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(ROOT, 'web')));

const ok = (res, data = {}) => res.json({ ok: true, ...data });
const fail = (res, err, code = 400) => res.status(code).json({ ok: false, error: String(err?.message || err) });

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
    proxyLabel: proxy ? `${proxy.type}://${proxy.host}:${proxy.port}` : '不使用代理（直连本机 IP）',
    proxyResolved: !!proxy,
  };
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

app.get('/api/profiles/:id/size', (req, res) => {
  ok(res, { bytes: profileDirSize(req.params.id) });
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

app.delete('/api/profiles/:id', async (req, res) => {
  const idx = db.profiles.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return fail(res, '环境不存在', 404);
  if (isRunning(req.params.id)) await closeProfile(req.params.id);
  db.profiles.splice(idx, 1);
  if (req.query.purge === '1') removeProfileDir(req.params.id);
  save();
  ok(res);
});

// ---------------------------------------------------------------- 打开 / 关闭

app.post('/api/profiles/:id/launch', async (req, res) => {
  const p = db.profiles.find((x) => x.id === req.params.id);
  if (!p) return fail(res, '环境不存在', 404);
  try {
    const info = await launchProfile({ ...p, proxy: resolveProxy(p) }, { force: !!req.body?.force, index: Number(req.body?.index) || 0 });
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
      const info = await launchProfile({ ...p, proxy: resolveProxy(p) }, { force, index: slot });
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
  for (const id of ids) await closeProfile(id).catch(() => {});
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
    return fail(res, `有 ${inUse.length} 个环境正在用这条代理：${inUse.map((p) => p.name).join('、')}`);
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

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      added.push(parseProxyLine(line, defType));
    } catch (err) {
      errors.push(`${line} —— ${err.message}`);
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
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) throw new Error('端口不合法');
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
  for (const p of db.profiles) if (ids.includes(p.id)) p.group = group;
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
  for (const g of data.groups || []) {
    if (!db.groups.find((x) => x.id === g.id)) db.groups.push(g);
  }
  for (const px of data.proxies || []) {
    if (!db.proxies.find((x) => x.id === px.id)) db.proxies.push(px);
  }
  let added = 0;
  for (const p of data.profiles) {
    if (db.profiles.find((x) => x.id === p.id)) {
      // ID 撞了就换一个，不覆盖现有环境
      const fresh = { ...p, id: newId('env'), name: `${p.name}-导入` };
      db.profiles.push(fresh);
    } else {
      db.profiles.push(p);
    }
    added += 1;
  }
  save();
  ok(res, { added });
});

// ---------------------------------------------------------------- 自动化本地接口
// 给 Playwright / Puppeteer 脚本用：拿到 CDP 地址直接接管浏览器。

/** 自动化接口统一支持用环境 ID 或名字定位 */
const findProfile = (idOrName) => db.profiles.find((x) => x.id === idOrName || x.name === idOrName) || null;

app.get('/api/v1/browser/start', async (req, res) => {
  const p = findProfile(req.query.profile_id || req.query.user_id);
  if (!p) return res.json({ code: -1, msg: '环境不存在' });
  try {
    if (isRunning(p.id)) {
      const rt = runtimeInfo(p.id);
      return res.json({ code: 0, msg: 'already running', data: cdpPayload(rt.cdpPort) });
    }
    const info = await launchProfile({ ...p, proxy: resolveProxy(p), automation: true }, { force: req.query.force === '1' });
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

app.use((err, _req, res, _next) => fail(res, err, 500));

const PORT = Number(process.env.PORT) || db.settings.port || 3131;

const server = app.listen(PORT, '127.0.0.1', async () => {
  const engines = listEngines().filter((e) => e.installed);
  const adopted = await adoptOrphans();
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
