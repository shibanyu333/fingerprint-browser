'use strict';

const state = {
  profiles: [], groups: [], proxies: [], settings: {}, engines: [], options: null,
  view: 'profiles', group: 'all', search: '', selected: new Set(), installTimer: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const ago = (ts) => {
  if (!ts) return '从未打开';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};

/** 代理检测结果里值得警告的部分 */
function ipWarnings(info) {
  if (!info) return '';
  const out = [];
  if (info.hosting || info.flaggedProxy) {
    out.push('⚠️ 被识别为机房 / 代理 IP，电商平台风控更严，建议换住宅 IP');
  }
  if (info.crossCheck?.conflict) {
    out.push(`⚠️ 两个地理库对这个 IP 判断不一致：ip-api 说 ${esc(info.timezone)}，`
      + `${esc(info.crossCheck.source)} 说 ${esc(info.crossCheck.timezone)}。`
      + '平台用的是哪一家不确定，可能被判"时区与 IP 不符"，建议换条定位更明确的 IP');
  }
  return out.map((t) => `<div class="sub" style="color:var(--amber);margin-top:4px">${t}</div>`).join('');
}

function toast(msg, kind = 'ok', ms = 3600) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: '服务端返回了非 JSON' }));
  if (!data.ok && data.error) throw new Error(data.error);
  return data;
}

async function refresh() {
  const data = await api('/state');
  Object.assign(state, {
    profiles: data.profiles, groups: data.groups, proxies: data.proxies,
    settings: data.settings, engines: data.engines,
  });
  if (!state.options) state.options = (await api('/options'));
  render();
}

// ================================================================ 渲染

function render() {
  renderSidebar();
  const views = { profiles: renderProfiles, proxies: renderProxies, engines: renderEngines, settings: renderSettings };
  (views[state.view] || renderProfiles)();
  const fpEngine = state.engines.find((e) => e.kind === 'fingerprint' && e.installed);
  $('#foot-status').innerHTML = fpEngine
    ? `内核：${esc(fpEngine.name)}`
    : '<span style="color:var(--amber)">未安装指纹内核</span>';
}

function renderSidebar() {
  const counts = {};
  for (const p of state.profiles) counts[p.group] = (counts[p.group] || 0) + 1;

  const items = [{ id: 'all', name: '全部环境' }, ...state.groups];
  $('#group-list').innerHTML = items.map((g) => `
    <div class="nav-item ${state.view === 'profiles' && state.group === g.id ? 'active' : ''}" data-group="${esc(g.id)}">
      <span>${esc(g.name)}</span>
      <span>
        ${g.id !== 'all' && g.id !== 'default' ? `<span class="edit" data-editgroup="${esc(g.id)}">改名</span> ` : ''}
        <span class="count">${g.id === 'all' ? state.profiles.length : counts[g.id] || 0}</span>
      </span>
    </div>`).join('');

  $('#proxy-count').textContent = state.proxies.length;
  document.querySelectorAll('.nav-item[data-view]').forEach((el) => {
    el.classList.toggle('active', state.view === el.dataset.view);
  });
}

function filteredProfiles() {
  const q = state.search.trim().toLowerCase();
  return state.profiles.filter((p) => {
    if (state.group !== 'all' && p.group !== state.group) return false;
    if (!q) return true;
    return [p.name, p.shop, p.account, p.notes, p.lastIpInfo?.ip, p.proxyLabel]
      .some((v) => String(v || '').toLowerCase().includes(q));
  });
}

function renderProfiles() {
  const list = filteredProfiles();
  const sel = state.selected;
  const runningCount = state.profiles.filter((p) => p.running).length;

  $('#topbar').innerHTML = `
    <h2>环境列表</h2>
    <span class="pill ${runningCount ? 'on' : 'off'}"><i class="dot"></i>运行中 ${runningCount}</span>
    <div class="spacer"></div>
    <button class="btn" id="btn-batch-open" ${sel.size ? '' : 'disabled'}>打开选中 (${sel.size})</button>
    <button class="btn" id="btn-batch-close" ${sel.size ? '' : 'disabled'}>关闭选中</button>
    <button class="btn danger" id="btn-close-all" ${runningCount ? '' : 'disabled'}>全部关闭</button>
    <button class="btn" id="btn-new-batch">批量创建</button>
    <button class="btn primary" id="btn-new">新建环境</button>`;

  $('#content').innerHTML = `
    <div class="searchbar">
      <input class="input" id="search" placeholder="搜索环境名 / 店铺 / 账号 / IP…" value="${esc(state.search)}">
      ${sel.size ? `<select class="input" id="move-group" style="max-width:180px">
        <option value="">移动到分组…</option>
        ${state.groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}
      </select>` : ''}
    </div>
    ${list.length ? `
    <div class="table-wrap"><table>
      <thead><tr>
        <th style="width:34px"><input type="checkbox" id="check-all" ${sel.size && sel.size === list.length ? 'checked' : ''}></th>
        <th>环境</th><th>代理 / 出口 IP</th><th>指纹</th><th>状态</th><th style="text-align:right">操作</th>
      </tr></thead>
      <tbody>${list.map(rowHtml).join('')}</tbody>
    </table></div>` : `
    <div class="empty">
      <h3>${state.search ? '没有匹配的环境' : '还没有环境'}</h3>
      <p>每个环境 = 一套独立的 Cookie + 指纹 + 代理 IP，互相之间完全隔离。</p>
      ${state.search ? '' : '<button class="btn primary" id="btn-empty-new">创建第一个环境</button>'}
    </div>`}`;

  bindProfileEvents();
}

function rowHtml(p) {
  const ip = p.lastIpInfo;
  const fp = p.fingerprint;
  const platLabel = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }[fp.platform] || fp.platform;

  let ipHtml = '<span class="sub">未检测</span>';
  if (ip) {
    const risky = ip.hosting || ip.flaggedProxy;
    const tzConflict = ip.crossCheck?.conflict;
    const flags = [risky ? '机房IP' : '', tzConflict ? '时区库有分歧' : ''].filter(Boolean).join(' · ');
    ipHtml = `<span class="pill ${risky || tzConflict ? 'warn' : 'on'}">${esc(ip.ip)}</span>
      <div class="sub">${esc(ip.countryCode || '')} ${esc(ip.city || '')} · ${ip.latency}ms${flags ? ` · ${esc(flags)}` : ''}</div>`;
  }

  return `<tr data-id="${esc(p.id)}">
    <td><input type="checkbox" class="row-check" ${state.selected.has(p.id) ? 'checked' : ''}></td>
    <td>
      <div class="name-cell">
        <b>${esc(p.name)}</b>
        <span class="sub">${esc([p.shop, p.account].filter(Boolean).join(' · ') || p.notes || '—')}</span>
      </div>
    </td>
    <td>
      <div class="sub mono">${esc(p.proxyLabel)}</div>
      ${ipHtml}
    </td>
    <td>
      <span class="pill">${esc(platLabel)} · ${esc(fp.brand)}</span>
      <div class="sub">${esc(fp.timezone)} · ${esc(fp.lang)} · 种子 ${fp.seed}</div>
    </td>
    <td>
      ${p.running
    ? `<span class="pill on"><i class="dot"></i>运行中</span><div class="sub">${p.runtime?.cdpPort ? `CDP :${p.runtime.cdpPort}` : ''}</div>`
    : `<span class="pill off"><i class="dot"></i>未运行</span><div class="sub">${ago(p.lastRunAt)}</div>`}
    </td>
    <td class="actions">
      ${p.running
    ? `<button class="btn sm" data-act="close">关闭</button>`
    : `<button class="btn sm primary" data-act="open">打开</button>`}
      <button class="btn sm ghost" data-act="check">检测</button>
      <button class="btn sm ghost" data-act="edit">编辑</button>
      <button class="btn sm ghost" data-act="more">⋯</button>
    </td>
  </tr>`;
}

function bindProfileEvents() {
  const search = $('#search');
  if (search) {
    search.oninput = (e) => {
      state.search = e.target.value;
      const pos = e.target.selectionStart;
      renderProfiles();
      const s = $('#search');
      s.focus();
      s.setSelectionRange(pos, pos);
    };
  }

  const checkAll = $('#check-all');
  if (checkAll) {
    checkAll.onchange = (e) => {
      state.selected = e.target.checked ? new Set(filteredProfiles().map((p) => p.id)) : new Set();
      renderProfiles();
    };
  }

  document.querySelectorAll('tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    const p = state.profiles.find((x) => x.id === id);
    tr.querySelector('.row-check').onchange = (e) => {
      if (e.target.checked) state.selected.add(id);
      else state.selected.delete(id);
      renderProfiles();
    };
    tr.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => handleAction(btn.dataset.act, p, btn);
    });
  });

  const move = $('#move-group');
  if (move) {
    move.onchange = async (e) => {
      if (!e.target.value) return;
      await api('/batch/move-group', { method: 'POST', body: { ids: [...state.selected], group: e.target.value } });
      state.selected.clear();
      toast('已移动分组');
      refresh();
    };
  }

  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on('#btn-new', () => profileModal(null));
  on('#btn-empty-new', () => profileModal(null));
  on('#btn-new-batch', () => batchCreateModal());
  on('#btn-batch-open', batchOpen);
  on('#btn-batch-close', async () => {
    await api('/batch/close', { method: 'POST', body: { ids: [...state.selected] } });
    toast('已关闭选中环境');
    refresh();
  });
  on('#btn-close-all', async () => {
    const r = await api('/batch/close-all', { method: 'POST', body: {} });
    toast(`已关闭 ${r.closed} 个环境`);
    refresh();
  });
}

async function handleAction(act, p, btn) {
  try {
    if (act === 'open') {
      btn.disabled = true;
      btn.textContent = '启动中…';
      const r = await api(`/profiles/${p.id}/launch`, { method: 'POST', body: {} });
      toast(`已打开「${p.name}」${r.info.ipInfo ? ` · 出口 ${r.info.ipInfo.ip}` : ''}`);
      refresh();
    } else if (act === 'close') {
      await api(`/profiles/${p.id}/close`, { method: 'POST', body: {} });
      refresh();
    } else if (act === 'check') {
      btn.disabled = true;
      btn.textContent = '检测中…';
      const r = await api(`/profiles/${p.id}/check`, { method: 'POST', body: {} });
      toast(`${r.info.ip} · ${r.info.country} ${r.info.city} · ${r.info.latency}ms`);
      refresh();
    } else if (act === 'edit') {
      profileModal(p);
    } else if (act === 'more') {
      moreMenu(p, btn);
    }
  } catch (err) {
    toast(err.message, 'err', 7000);
    refresh();
  }
}

async function batchOpen() {
  const ids = [...state.selected];
  toast(`正在依次打开 ${ids.length} 个环境…`);
  const r = await api('/batch/launch', { method: 'POST', body: { ids } });
  const failed = r.results.filter((x) => !x.ok);
  if (failed.length) {
    toast(`${r.results.length - failed.length} 个已打开，${failed.length} 个失败：${failed.map((f) => `${f.name}(${f.error})`).join('；')}`, 'err', 10000);
  } else {
    toast(`${r.results.length} 个环境已全部打开`);
  }
  refresh();
}

function moreMenu(p, btn) {
  modal({
    title: `${p.name}`,
    body: `
      <div class="callout">环境 ID <code>${esc(p.id)}</code><br>创建于 ${new Date(p.createdAt).toLocaleString('zh-CN')}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" data-x="clone">克隆环境（换新指纹）</button>
        <button class="btn" data-x="reseed">重新随机指纹（换一台"电脑"）</button>
        <button class="btn" data-x="force">强制打开（跳过代理检测）</button>
        <button class="btn danger" data-x="del">删除环境（保留数据目录）</button>
        <button class="btn danger" data-x="purge">删除环境并清空 Cookie 数据</button>
      </div>`,
    footer: '<button class="btn" data-close>关闭</button>',
    onMount(root, close) {
      const act = async (fn, msg) => {
        try { await fn(); close(); toast(msg); refresh(); } catch (e) { toast(e.message, 'err', 7000); }
      };
      root.querySelector('[data-x=clone]').onclick = () => act(() => api(`/profiles/${p.id}/clone`, { method: 'POST', body: {} }), '已克隆');
      root.querySelector('[data-x=reseed]').onclick = () => act(() => api(`/profiles/${p.id}/reseed`, { method: 'POST', body: {} }), '指纹已重新生成');
      root.querySelector('[data-x=force]').onclick = () => act(() => api(`/profiles/${p.id}/launch`, { method: 'POST', body: { force: true } }), '已强制打开（注意可能在用真实 IP）');
      root.querySelector('[data-x=del]').onclick = () => {
        if (!confirm(`删除环境「${p.name}」？浏览器数据目录会保留在 profiles/ 下。`)) return;
        act(() => api(`/profiles/${p.id}`, { method: 'DELETE' }), '已删除');
      };
      root.querySelector('[data-x=purge]').onclick = () => {
        if (!confirm(`彻底删除「${p.name}」？\n\n该环境的 Cookie、登录状态、缓存会一并抹掉，无法恢复。`)) return;
        act(() => fetch(`/api/profiles/${p.id}?purge=1`, { method: 'DELETE' }).then((r) => r.json()), '已彻底删除');
      };
    },
  });
}

// ================================================================ 环境编辑弹窗

function profileModal(p) {
  const isNew = !p;
  const opt = state.options;
  const draft = p ? structuredClone(p) : {
    name: '', group: state.group === 'all' ? 'default' : state.group,
    shop: '', account: '', notes: '', startUrl: '', engineId: '', automation: false,
    proxy: { mode: 'none', type: 'socks5', host: '', port: '', username: '', password: '' },
    fingerprint: { platform: 'windows', brand: 'Chrome', lang: 'en-US', acceptLang: 'en-US,en', timezone: 'America/New_York', autoLocale: true, webrtc: 'disabled', seed: 0 },
    window: {},
  };
  let tab = 'basic';

  const tabsHtml = () => `
    <div class="tabs">
      ${[['basic', '基础'], ['proxy', '代理 IP'], ['fp', '指纹'], ['adv', '高级']]
    .map(([k, label]) => `<div class="tab ${tab === k ? 'active' : ''}" data-tab="${k}">${label}</div>`).join('')}
    </div>`;

  const bodyHtml = () => {
    if (tab === 'basic') {
      return `
        <div class="row">
          <div class="field"><label>环境名称 *</label><input class="input" data-f="name" value="${esc(draft.name)}" placeholder="例：US-Amazon-01"></div>
          <div class="field"><label>分组</label><select class="input" data-f="group">
            ${state.groups.map((g) => `<option value="${esc(g.id)}" ${draft.group === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
          </select></div>
        </div>
        <div class="row">
          <div class="field"><label>平台 / 店铺</label><input class="input" data-f="shop" value="${esc(draft.shop)}" placeholder="Amazon / TikTok Shop / eBay…"></div>
          <div class="field"><label>账号备注</label><input class="input" data-f="account" value="${esc(draft.account)}" placeholder="登录邮箱或账号名"></div>
        </div>
        <div class="field"><label>启动后自动打开网址</label><input class="input" data-f="startUrl" value="${esc(draft.startUrl)}" placeholder="https://sellercentral.amazon.com"></div>
        <div class="field"><label>备注</label><textarea class="input" data-f="notes" style="min-height:64px">${esc(draft.notes)}</textarea></div>`;
    }

    if (tab === 'proxy') {
      const px = draft.proxy || {};
      return `
        <div class="callout">
          代理是防关联的第一道也是最重要的一道。<b>一个环境固定一个 IP</b>，不要几个店铺共用出口。<br>
          带账号密码的 SOCKS5 由本地中继完成认证，浏览器只连 <code>127.0.0.1</code>，不会泄露 DNS。
        </div>
        <div class="field"><label>代理来源</label><select class="input" data-f="proxy.mode">
          <option value="none" ${px.mode === 'none' ? 'selected' : ''}>不使用代理（直连本机 IP，仅测试用）</option>
          <option value="pool" ${px.mode === 'pool' ? 'selected' : ''}>从代理池选择</option>
          <option value="custom" ${px.mode === 'custom' ? 'selected' : ''}>单独填写</option>
        </select></div>
        ${px.mode === 'pool' ? `
        <div class="field"><label>选择代理</label><select class="input" data-f="proxy.poolId">
          <option value="">— 请选择 —</option>
          ${state.proxies.map((x) => `<option value="${esc(x.id)}" ${px.poolId === x.id ? 'selected' : ''}>${esc(x.label)} (${esc(x.type)})</option>`).join('')}
        </select>${state.proxies.length ? '' : '<div class="hint">代理池是空的，先去左侧「代理池」添加。</div>'}</div>` : ''}
        ${px.mode === 'custom' ? `
        <div class="row">
          <div class="field" style="flex:0 0 130px"><label>类型</label><select class="input" data-f="proxy.type">
            ${['socks5', 'socks4', 'http', 'https'].map((t) => `<option ${px.type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select></div>
          <div class="field"><label>主机</label><input class="input" data-f="proxy.host" value="${esc(px.host)}" placeholder="1.2.3.4"></div>
          <div class="field" style="flex:0 0 110px"><label>端口</label><input class="input" data-f="proxy.port" value="${esc(px.port)}" placeholder="1080"></div>
        </div>
        <div class="row">
          <div class="field"><label>用户名</label><input class="input" data-f="proxy.username" value="${esc(px.username)}"></div>
          <div class="field"><label>密码</label><input class="input" type="password" data-f="proxy.password" value="${esc(px.password)}"></div>
        </div>
        <button class="btn" data-x="test-proxy">测试这条代理</button>
        <div id="proxy-test-result" style="margin-top:10px"></div>` : ''}`;
    }

    if (tab === 'fp') {
      const fp = draft.fingerprint;
      const plat = opt.platforms.find((x) => x.key === fp.platform) || opt.platforms[0];
      const brand = opt.brands.find((x) => x.key === fp.brand) || opt.brands[0];
      return `
        <div class="callout">
          指纹由<b>种子</b>决定：同一个种子 = 同一台"虚拟电脑"，canvas / WebGL / 音频 / 字体噪声每次都一样。<br>
          不同环境务必用不同种子 —— 这正是平台用来判定"同一个人"的依据。
        </div>
        <div class="row">
          <div class="field"><label>指纹种子</label>
            <div style="display:flex;gap:8px">
              <input class="input" data-f="fingerprint.seed" value="${fp.seed || ''}" placeholder="留空自动生成">
              <button class="btn" data-x="reroll">换一个</button>
            </div>
          </div>
          <div class="field"><label>操作系统</label><select class="input" data-f="fingerprint.platform">
            ${opt.platforms.map((x) => `<option value="${esc(x.key)}" ${fp.platform === x.key ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}
          </select></div>
        </div>
        <div class="row">
          <div class="field"><label>系统版本</label><select class="input" data-f="fingerprint.platformVersion">
            ${plat.versions.map((v) => `<option ${fp.platformVersion === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select></div>
          <div class="field"><label>浏览器品牌</label><select class="input" data-f="fingerprint.brand">
            ${opt.brands.map((x) => `<option value="${esc(x.key)}" ${fp.brand === x.key ? 'selected' : ''}>${esc(x.key)}</option>`).join('')}
          </select></div>
          <div class="field"><label>品牌版本</label><select class="input" data-f="fingerprint.brandVersion">
            <option value="" ${!fp.brandVersion ? 'selected' : ''}>自动（推荐）</option>
            ${brand.versions.map((v) => `<option ${fp.brandVersion === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select><div class="hint">改成固定版本会让 UA 字符串和 userAgentData 对不上，除非你清楚在做什么，否则保持自动。</div></div>
        </div>
        <div class="field">
          <label class="check"><input type="checkbox" data-f="fingerprint.autoLocale" ${fp.autoLocale !== false ? 'checked' : ''}>
            打开时按代理出口 IP 自动校正语言和时区（推荐）</label>
          <div class="hint">开着它，美国 IP 就会自动配 en-US + America/New_York，避免"IP 在美国、时区在上海"这种一眼假的组合。</div>
        </div>
        <div class="row">
          <div class="field"><label>语言</label><input class="input" data-f="fingerprint.lang" value="${esc(fp.lang)}"></div>
          <div class="field"><label>Accept-Language</label><input class="input" data-f="fingerprint.acceptLang" value="${esc(fp.acceptLang)}"></div>
        </div>
        <div class="row">
          <div class="field"><label>时区</label><select class="input" data-f="fingerprint.timezone">
            ${opt.timezones.map((t) => `<option ${fp.timezone === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
          </select></div>
          <div class="field"><label>CPU 核心数</label><input class="input" data-f="fingerprint.hardwareConcurrency" value="${fp.hardwareConcurrency || ''}" placeholder="按种子随机"></div>
          <div class="field"><label>WebRTC</label><select class="input" data-f="fingerprint.webrtc">
            <option value="disabled" ${fp.webrtc === 'disabled' ? 'selected' : ''}>禁止非代理 UDP（防 IP 泄露）</option>
            <option value="default" ${fp.webrtc === 'default' ? 'selected' : ''}>保持默认（不推荐）</option>
          </select></div>
        </div>
        <div class="row">
          <div class="field"><label>屏幕分辨率</label><select class="input" data-f="fingerprint.screenPreset">
            ${opt.screens.map((s) => `<option value="${s.w}x${s.h}" ${fp.screen?.w === s.w && fp.screen?.h === s.h ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
          </select></div>
          <div class="field" style="display:flex;align-items:flex-end;padding-bottom:8px">
            <label class="check"><input type="checkbox" data-f="fingerprint.spoofScreen" ${fp.spoofScreen !== false ? 'checked' : ''}>启用分辨率伪装</label>
          </div>
        </div>
        <div class="hint" style="margin-top:-6px">
          不开的话 screen.width/height 会直接报你这台 Mac 的真实分辨率 —— 一个自称 Windows 的浏览器
          报 1470×956，Pixelscan 会直接判定 masking。开启后由浏览器原生接口覆盖，不影响页面布局和窗口大小。
        </div>`;
    }

    const fp = draft.fingerprint;
    const engines = state.engines.filter((e) => e.installed);
    return `
      <div class="field"><label>使用的浏览器内核</label><select class="input" data-f="engineId">
        <option value="">跟随默认（优先指纹内核）</option>
        ${engines.map((e) => `<option value="${esc(e.id)}" ${draft.engineId === e.id ? 'selected' : ''}>${esc(e.name)}${e.kind === 'system' ? '（弱指纹）' : ''}</option>`).join('')}
      </select><div class="hint">系统自带 Chrome 只能做浅层伪装，正式养号请用 Fingerprint Chromium。</div></div>
      <div class="field"><label class="check"><input type="checkbox" data-f="automation" ${draft.automation ? 'checked' : ''}>
        开启自动化端口（Playwright / Puppeteer 可接管）</label></div>
      <div class="row">
        <div class="field"><label>窗口宽</label><input class="input" data-f="window.width" value="${draft.window?.width || ''}" placeholder="跟随全局设置"></div>
        <div class="field"><label>窗口高</label><input class="input" data-f="window.height" value="${draft.window?.height || ''}" placeholder="跟随全局设置"></div>
      </div>
      <div class="field"><label>关闭部分指纹伪装（排查网站显示异常时用）</label>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px">
          ${['font', 'audio', 'canvas', 'clientrects', 'gpu'].map((k) => `
            <label class="check"><input type="checkbox" data-spoof="${k}" ${fp.disableSpoofing?.includes(k) ? 'checked' : ''}>${k}</label>`).join('')}
        </div>
        <div class="hint">比如某些网站画布渲染错乱，可以临时关掉 canvas 伪装。关得越多越容易被关联。</div>
      </div>
      <div class="field"><label>自定义启动参数</label><input class="input" data-f="fingerprint.customArgs" value="${esc(fp.customArgs || '')}" placeholder="--disable-features=xxx --mute-audio"></div>`;
  };

  modal({
    title: isNew ? '新建环境' : `编辑：${p.name}`,
    body: `<div id="pm-tabs">${tabsHtml()}</div><div id="pm-body">${bodyHtml()}</div>`,
    footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-x="save">保存</button>',
    onMount(root, close) {
      const rerender = () => {
        $('#pm-tabs', root).innerHTML = tabsHtml();
        $('#pm-body', root).innerHTML = bodyHtml();
        bind();
      };

      const setPath = (path, val) => {
        const keys = path.split('.');
        let obj = draft;
        while (keys.length > 1) {
          const k = keys.shift();
          obj[k] = obj[k] || {};
          obj = obj[k];
        }
        obj[keys[0]] = val;
      };

      function bind() {
        root.querySelectorAll('[data-tab]').forEach((el) => {
          el.onclick = () => { tab = el.dataset.tab; rerender(); };
        });

        root.querySelectorAll('[data-f]').forEach((el) => {
          const path = el.dataset.f;
          const isCheck = el.type === 'checkbox';
          el.onchange = () => {
            setPath(path, isCheck ? el.checked : el.value);
            // 切换代理模式 / 系统 / 品牌时，下面的选项要跟着变
            if (['proxy.mode', 'fingerprint.platform', 'fingerprint.brand'].includes(path)) {
              if (path === 'fingerprint.platform') draft.fingerprint.platformVersion = '';
              if (path === 'fingerprint.brand') draft.fingerprint.brandVersion = '';
              rerender();
            }
          };
        });

        root.querySelectorAll('[data-spoof]').forEach((el) => {
          el.onchange = () => {
            const set = new Set(draft.fingerprint.disableSpoofing || []);
            if (el.checked) set.add(el.dataset.spoof); else set.delete(el.dataset.spoof);
            draft.fingerprint.disableSpoofing = [...set];
          };
        });

        const reroll = root.querySelector('[data-x=reroll]');
        if (reroll) {
          reroll.onclick = () => {
            draft.fingerprint.seed = Math.floor(Math.random() * 2147483647) + 1;
            rerender();
          };
        }

        const testBtn = root.querySelector('[data-x=test-proxy]');
        if (testBtn) {
          testBtn.onclick = async () => {
            const out = $('#proxy-test-result', root);
            testBtn.disabled = true;
            out.innerHTML = '<span class="sub">检测中…</span>';
            try {
              const r = await api('/proxies/check', { method: 'POST', body: draft.proxy });
              out.innerHTML = `<span class="pill on">${esc(r.info.ip)}</span>
                <span class="sub"> ${esc(r.info.country)} ${esc(r.info.city)} · ${esc(r.info.timezone)} · ${r.info.latency}ms · ${esc(r.info.isp)}</span>
                ${ipWarnings(r.info)}`;
            } catch (err) {
              out.innerHTML = `<span class="pill bad">失败</span> <span class="sub">${esc(err.message)}</span>`;
            }
            testBtn.disabled = false;
          };
        }
      }

      bind();

      root.querySelector('[data-x=save]').onclick = async () => {
        if (!draft.name.trim()) { toast('环境名称不能填空', 'err'); return; }
        const body = { ...draft };
        body.fingerprint = { ...draft.fingerprint, seed: Number(draft.fingerprint.seed) || 0 };
        if (body.fingerprint.screenPreset) {
          const [w, h] = String(body.fingerprint.screenPreset).split('x').map(Number);
          if (w && h) body.fingerprint.screen = { w, h };
          delete body.fingerprint.screenPreset;
        }
        if (body.window) {
          body.window = { width: Number(body.window.width) || 0, height: Number(body.window.height) || 0 };
        }
        try {
          if (isNew) await api('/profiles', { method: 'POST', body });
          else await api(`/profiles/${p.id}`, { method: 'PUT', body });
          close();
          toast(isNew ? '环境已创建' : '已保存');
          refresh();
        } catch (err) {
          toast(err.message, 'err', 7000);
        }
      };
    },
  });
}

function batchCreateModal() {
  modal({
    title: '批量创建环境',
    body: `
      <div class="callout">批量创建时<b>每个环境都会分配独立的随机指纹种子</b>，绝不会出现两个一模一样的浏览器。代理需要创建后再分别绑定。</div>
      <div class="row">
        <div class="field"><label>名称前缀</label><input class="input" id="bc-name" value="环境" placeholder="US-Amazon"></div>
        <div class="field" style="flex:0 0 120px"><label>数量</label><input class="input" id="bc-count" value="5" type="number" min="1" max="100"></div>
      </div>
      <div class="row">
        <div class="field"><label>分组</label><select class="input" id="bc-group">
          ${state.groups.map((g) => `<option value="${esc(g.id)}" ${state.group === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        </select></div>
        <div class="field"><label>模拟系统</label><select class="input" id="bc-plat">
          <option value="">随机（推荐）</option>
          <option value="windows">Windows</option>
          <option value="macos">macOS</option>
        </select></div>
      </div>`,
    footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-x="go">创建</button>',
    onMount(root, close) {
      root.querySelector('[data-x=go]').onclick = async () => {
        const body = {
          name: $('#bc-name', root).value.trim() || '环境',
          count: Number($('#bc-count', root).value) || 1,
          group: $('#bc-group', root).value,
          fingerprint: { platform: $('#bc-plat', root).value || undefined },
        };
        try {
          const r = await api('/profiles', { method: 'POST', body });
          close();
          toast(`已创建 ${r.created.length} 个环境`);
          refresh();
        } catch (err) { toast(err.message, 'err'); }
      };
    },
  });
}

// ================================================================ 代理池

function renderProxies() {
  $('#topbar').innerHTML = `
    <h2>代理池</h2>
    <div class="spacer"></div>
    <button class="btn" id="btn-check-all-px">全部检测</button>
    <button class="btn" id="btn-import-px">批量导入</button>
    <button class="btn primary" id="btn-add-px">添加代理</button>`;

  $('#content').innerHTML = `
    <div class="callout">
      电商防关联的铁律：<b>一个店铺一个固定 IP</b>，优先住宅 / 静态 ISP，避开机房 IP 和共享出口。<br>
      这里支持 <code>socks5</code>、<code>socks4</code>、<code>http</code>、<code>https</code>，<b>带用户名密码的都能用</b>。
    </div>
    ${state.proxies.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>代理</th><th>类型</th><th>认证</th><th>最近检测</th><th>绑定环境</th><th style="text-align:right">操作</th></tr></thead>
      <tbody>${state.proxies.map((x) => {
    const used = state.profiles.filter((p) => p.proxy?.mode === 'pool' && p.proxy.poolId === x.id);
    const c = x.lastCheck;
    return `<tr data-id="${esc(x.id)}">
          <td><b>${esc(x.label)}</b><div class="sub mono">${esc(x.host)}:${x.port}</div></td>
          <td><span class="pill">${esc(x.type)}</span></td>
          <td class="sub">${x.username ? `${esc(x.username)} / ••••••` : '无需认证'}</td>
          <td>${c ? `<span class="pill ${c.ok ? 'on' : 'bad'}">${esc(c.ip || '失败')}</span><div class="sub">${esc(c.countryCode || '')} ${esc(c.city || '')} ${c.latency ? `· ${c.latency}ms` : ''}</div>` : '<span class="sub">未检测</span>'}</td>
          <td class="sub">${used.length ? `${used.length} 个` : '—'}</td>
          <td class="actions">
            <button class="btn sm" data-px="check">检测</button>
            <button class="btn sm ghost" data-px="edit">编辑</button>
            <button class="btn sm ghost danger" data-px="del">删除</button>
          </td>
        </tr>`;
  }).join('')}</tbody>
    </table></div>` : '<div class="empty"><h3>代理池是空的</h3><p>先把你的 SOCKS5 加进来，再绑定到各个环境。</p></div>'}`;

  $('#btn-add-px').onclick = () => proxyModal(null);
  $('#btn-import-px').onclick = importProxyModal;
  $('#btn-check-all-px').onclick = async () => {
    toast(`正在检测 ${state.proxies.length} 条代理…`);
    for (const px of state.proxies) await checkOneProxy(px.id);
    refresh();
  };

  document.querySelectorAll('tbody tr').forEach((tr) => {
    const px = state.proxies.find((x) => x.id === tr.dataset.id);
    tr.querySelectorAll('[data-px]').forEach((btn) => {
      btn.onclick = async () => {
        const act = btn.dataset.px;
        if (act === 'edit') return proxyModal(px);
        if (act === 'del') {
          if (!confirm(`删除代理「${px.label}」？`)) return;
          try {
            await api(`/proxies/${px.id}`, { method: 'DELETE' });
            toast('已删除');
            refresh();
          } catch (err) {
            if (confirm(`${err.message}\n\n仍然删除吗？这些环境会变成"无代理"。`)) {
              await fetch(`/api/proxies/${px.id}?force=1`, { method: 'DELETE' });
              refresh();
            }
          }
          return;
        }
        btn.disabled = true;
        btn.textContent = '…';
        await checkOneProxy(px.id);
        refresh();
      };
    });
  });
}

async function checkOneProxy(id) {
  const px = state.proxies.find((x) => x.id === id);
  try {
    const r = await api('/proxies/check', { method: 'POST', body: px });
    await api(`/proxies/${id}`, { method: 'PUT', body: { lastCheck: { ok: true, ...r.info } } });
  } catch (err) {
    await api(`/proxies/${id}`, { method: 'PUT', body: { lastCheck: { ok: false, error: err.message } } });
  }
}

function proxyModal(px) {
  const isNew = !px;
  const d = px ? { ...px } : { label: '', type: 'socks5', host: '', port: '', username: '', password: '', note: '' };
  modal({
    title: isNew ? '添加代理' : '编辑代理',
    body: `
      <div class="row">
        <div class="field" style="flex:0 0 130px"><label>类型</label><select class="input" id="px-type">
          ${['socks5', 'socks4', 'http', 'https'].map((t) => `<option ${d.type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
        <div class="field"><label>主机地址 *</label><input class="input" id="px-host" value="${esc(d.host)}" placeholder="proxy.example.com"></div>
        <div class="field" style="flex:0 0 110px"><label>端口 *</label><input class="input" id="px-port" value="${esc(d.port)}" placeholder="1080"></div>
      </div>
      <div class="row">
        <div class="field"><label>用户名</label><input class="input" id="px-user" value="${esc(d.username)}"></div>
        <div class="field"><label>密码</label><input class="input" id="px-pass" type="password" value="${esc(d.password)}"></div>
      </div>
      <div class="field"><label>备注名</label><input class="input" id="px-label" value="${esc(d.label)}" placeholder="留空则用 host:port"></div>
      <button class="btn" data-x="test">测试连通性</button>
      <div id="px-result" style="margin-top:10px"></div>`,
    footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-x="save">保存</button>',
    onMount(root, close) {
      const collect = () => ({
        type: $('#px-type', root).value,
        host: $('#px-host', root).value.trim(),
        port: Number($('#px-port', root).value),
        username: $('#px-user', root).value.trim(),
        password: $('#px-pass', root).value,
        label: $('#px-label', root).value.trim() || `${$('#px-host', root).value.trim()}:${$('#px-port', root).value}`,
      });

      root.querySelector('[data-x=test]').onclick = async (e) => {
        const out = $('#px-result', root);
        e.target.disabled = true;
        out.innerHTML = '<span class="sub">检测中…</span>';
        try {
          const r = await api('/proxies/check', { method: 'POST', body: collect() });
          out.innerHTML = `<span class="pill on">${esc(r.info.ip)}</span> <span class="sub">${esc(r.info.country)} ${esc(r.info.city)} · ${esc(r.info.timezone)} · ${r.info.latency}ms</span>${ipWarnings(r.info)}`;
        } catch (err) {
          out.innerHTML = `<span class="pill bad">失败</span> <span class="sub">${esc(err.message)}</span>`;
        }
        e.target.disabled = false;
      };

      root.querySelector('[data-x=save]').onclick = async () => {
        const body = collect();
        if (!body.host || !body.port) return toast('主机和端口必填', 'err');
        try {
          if (isNew) await api('/proxies', { method: 'POST', body });
          else await api(`/proxies/${px.id}`, { method: 'PUT', body });
          close();
          toast('已保存');
          refresh();
        } catch (err) { toast(err.message, 'err'); }
      };
    },
  });
}

function importProxyModal() {
  modal({
    title: '批量导入代理',
    body: `
      <div class="callout">一行一条，下面几种写法都认：<br>
        <code>1.2.3.4:1080</code><br>
        <code>1.2.3.4:1080:用户名:密码</code><br>
        <code>socks5://用户名:密码@1.2.3.4:1080</code>
      </div>
      <div class="field"><label>默认类型（没写协议头时用）</label><select class="input" id="im-type">
        ${['socks5', 'socks4', 'http', 'https'].map((t) => `<option>${t}</option>`).join('')}
      </select></div>
      <div class="field"><label>代理列表</label><textarea class="input" id="im-text" style="min-height:180px" placeholder="每行一条…"></textarea></div>`,
    footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-x="go">导入</button>',
    onMount(root, close) {
      root.querySelector('[data-x=go]').onclick = async () => {
        const body = { text: $('#im-text', root).value, type: $('#im-type', root).value };
        const r = await api('/proxies/import', { method: 'POST', body });
        close();
        toast(`导入 ${r.added} 条${r.errors.length ? `，${r.errors.length} 条格式不对被跳过` : ''}`, r.errors.length ? 'err' : 'ok', 6000);
        refresh();
      };
    },
  });
}

// ================================================================ 内核

function renderEngines() {
  $('#topbar').innerHTML = '<h2>浏览器内核</h2>';
  $('#content').innerHTML = `
    <div class="callout">
      指纹内核是 <b>fingerprint-chromium</b>（基于 ungoogled-chromium，BSD-3 协议）。
      它在 C++ 源码层改写 canvas / WebGL / 音频 / 字体 / UA / 时区，比浏览器插件那种 JS 补丁难检测得多。
    </div>
    <div id="engine-list">${state.engines.map(engineCard).join('')}</div>`;

  document.querySelectorAll('[data-install]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      await api(`/engines/${btn.dataset.install}/install`, { method: 'POST', body: {} });
      pollInstall();
    };
  });
}

function engineCard(e) {
  return `<div class="engine-card">
    <div class="grow">
      <h4>${esc(e.name)} ${e.kind === 'fingerprint' ? '<span class="pill on">指纹内核</span>' : '<span class="pill warn">弱指纹</span>'}</h4>
      <div class="sub">${e.version ? `版本 ${esc(e.version)} · ` : ''}${e.installed ? '已安装' : '未安装'}</div>
      ${e.path ? `<div class="mono">${esc(e.path)}</div>` : ''}
    </div>
    ${e.installed
    ? '<span class="pill on"><i class="dot"></i>可用</span>'
    : e.downloadable ? `<button class="btn primary" data-install="${esc(e.id)}">下载安装</button>` : ''}
  </div>`;
}

async function pollInstall() {
  clearInterval(state.installTimer);
  state.installTimer = setInterval(async () => {
    const { installState: s } = await api('/engines/install-state');
    const list = $('#engine-list');
    if (!list) return clearInterval(state.installTimer);
    if (s.busy) {
      list.innerHTML = `${state.engines.map(engineCard).join('')}
        <div class="engine-card"><div class="grow">
          <h4>${esc(s.step)}</h4>
          <div class="progress"><i style="width:${s.percent}%"></i></div>
        </div><span class="sub">${s.percent}%</span></div>`;
    } else {
      clearInterval(state.installTimer);
      if (s.error) toast(`安装失败：${s.error}`, 'err', 8000);
      else if (s.percent === 100) toast('内核安装完成');
      refresh();
    }
  }, 700);
}

// ================================================================ 设置

function renderSettings() {
  const g = state.settings.windowGrid || {};
  $('#topbar').innerHTML = '<h2>设置与备份</h2>';
  $('#content').innerHTML = `
    <h3 style="font-size:14px;margin:0 0 12px">批量打开时的窗口排布</h3>
    <div class="row" style="max-width:620px">
      <div class="field"><label>每行几个窗口</label><input class="input" id="s-cols" value="${g.cols}"></div>
      <div class="field"><label>窗口宽</label><input class="input" id="s-w" value="${g.width}"></div>
      <div class="field"><label>窗口高</label><input class="input" id="s-h" value="${g.height}"></div>
    </div>
    <div class="row" style="max-width:620px">
      <div class="field"><label>横向间距</label><input class="input" id="s-gx" value="${g.gapX}"></div>
      <div class="field"><label>纵向间距</label><input class="input" id="s-gy" value="${g.gapY}"></div>
      <div class="field"><label>顶部留白</label><input class="input" id="s-oy" value="${g.originY}"></div>
    </div>
    <button class="btn primary" id="s-save">保存设置</button>

    <h3 style="font-size:14px;margin:30px 0 12px">备份与迁移</h3>
    <div class="callout">
      导出的 JSON 包含全部环境配置、指纹和代理（含密码），换电脑时导入即可。<br>
      <b>但不含 Cookie 登录态</b> —— 登录数据在 <code>profiles/</code> 目录里，要一起搬就把整个项目文件夹拷走。
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn" id="s-export">导出配置</button>
      <button class="btn" id="s-import">导入配置</button>
    </div>

    <h3 style="font-size:14px;margin:30px 0 12px">给自动化脚本用的本地接口</h3>
    <div class="callout">
      环境开启「自动化端口」后，用下面的接口拿 CDP 地址，Playwright / Puppeteer 直接接管：<br>
      <code>GET http://127.0.0.1:${state.settings.port || 3131}/api/v1/browser/start?profile_id=环境ID</code><br>
      <code>GET .../api/v1/browser/stop?profile_id=环境ID</code> ·
      <code>GET .../api/v1/user/list</code>
    </div>`;

  $('#s-save').onclick = async () => {
    const num = (id, fb) => Number($(`#${id}`).value) || fb;
    await api('/settings', {
      method: 'PUT',
      body: {
        windowGrid: {
          cols: num('s-cols', 4), width: num('s-w', 1024), height: num('s-h', 720),
          gapX: num('s-gx', 24), gapY: num('s-gy', 24), originX: 0, originY: num('s-oy', 40),
        },
      },
    });
    toast('设置已保存');
    refresh();
  };
  $('#s-export').onclick = () => { window.location.href = '/api/export'; };
  $('#s-import').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const text = await input.files[0].text();
      try {
        const r = await api('/import', { method: 'POST', body: JSON.parse(text) });
        toast(`导入了 ${r.added} 个环境`);
        refresh();
      } catch (err) { toast(err.message, 'err'); }
    };
    input.click();
  };
}

// ================================================================ 通用弹窗

function modal({ title, body, footer, onMount }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal">
    <header><h3>${esc(title)}</h3></header>
    <div class="body">${body}</div>
    <footer>${footer || ''}</footer>
  </div>`;
  $('#modal-root').appendChild(overlay);

  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  const onEsc = (e) => {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  };
  document.addEventListener('keydown', onEsc);

  if (onMount) onMount(overlay.querySelector('.modal'), close);
}

// ================================================================ 启动

document.addEventListener('click', (e) => {
  const groupEl = e.target.closest('[data-group]');
  if (groupEl && !e.target.dataset.editgroup) {
    state.view = 'profiles';
    state.group = groupEl.dataset.group;
    state.selected.clear();
    render();
    return;
  }
  const editEl = e.target.closest('[data-editgroup]');
  if (editEl) {
    const g = state.groups.find((x) => x.id === editEl.dataset.editgroup);
    const name = prompt('分组名称', g.name);
    if (name === null) return;
    if (name.trim()) {
      api(`/groups/${g.id}`, { method: 'PUT', body: { name } }).then(refresh);
    } else if (confirm(`删除分组「${g.name}」？组内环境会移到"未分组"。`)) {
      api(`/groups/${g.id}`, { method: 'DELETE' }).then(refresh);
    }
    return;
  }
  const viewEl = e.target.closest('[data-view]');
  if (viewEl) {
    state.view = viewEl.dataset.view;
    render();
  }
});

$('#add-group').onclick = async () => {
  const name = prompt('新分组名称，例如：美国站 / TikTok / 备用号');
  if (!name || !name.trim()) return;
  await api('/groups', { method: 'POST', body: { name } });
  refresh();
};

// 有环境在跑的时候定时刷新状态，浏览器被手动关掉了列表也能跟上
setInterval(() => {
  if (state.view === 'profiles' && state.profiles.some((p) => p.running) && !$('.overlay')) refresh();
}, 5000);

refresh().catch((err) => {
  document.body.innerHTML = `<div class="empty"><h3>连不上管理端</h3><p>${esc(err.message)}</p></div>`;
});
