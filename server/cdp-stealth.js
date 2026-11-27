// 通过 CDP 给浏览器打补丁的一层，两种用法：
//
// 1. screen 模式（指纹内核用）：内核没有屏幕分辨率参数，screen.width/height 会直接暴露
//    这台 Mac 的真实分辨率（比如 1470x956）—— 一个自称 Windows 的浏览器报这个数，
//    Pixelscan 立刻判定 masking。用 Emulation.setDeviceMetricsOverride 在 Blink 层覆盖，
//    宽高传 0 表示不动视口，只改 screen.*，所以页面布局和窗口大小完全不受影响。
//    这是浏览器原生能力，不是 JS 补丁，改不出 toString 破绽。
//
// 2. full 模式（系统 Chrome 用）：系统浏览器没有源码级指纹改造，只能靠 CDP 覆盖
//    时区/语言/UA 再加一点 canvas 噪声。这层是 JS 补丁，专业检测站能看出来，
//    所以正式养号请用 fingerprint-chromium 内核。

import WebSocket from 'ws';
import http from 'node:http';

const patchScript = (fp) => `
(() => {
  const S = ${JSON.stringify({
    seed: fp.seed,
    cores: fp.hardwareConcurrency,
    memory: fp.deviceMemory,
    lang: fp.lang,
    langs: fp.acceptLang.split(','),
    platform: fp.platform === 'macos' ? 'MacIntel' : fp.platform === 'linux' ? 'Linux x86_64' : 'Win32',
  })};

  const def = (obj, prop, get) => {
    try { Object.defineProperty(obj, prop, { get, configurable: true }); } catch (e) {}
  };

  def(navigator, 'hardwareConcurrency', () => S.cores);
  def(navigator, 'deviceMemory', () => S.memory);
  def(navigator, 'language', () => S.lang);
  def(navigator, 'languages', () => Object.freeze(S.langs));
  def(navigator, 'platform', () => S.platform);
  def(navigator, 'webdriver', () => false);

  // 种子化的伪随机，保证同一个环境每次打开噪声一致 —— 噪声每次都变反而更可疑
  let s = S.seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const shift = [];
  for (let i = 0; i < 64; i++) shift.push(Math.floor(rnd() * 3) - 1);

  // 每隔 137 个像素动一下最低位，肉眼看不出来，但足以让 canvas 哈希跟别人不一样
  const STEP = 4 * 137;
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (...args) {
    const data = origGetImageData.apply(this, args);
    const px = data.data;
    for (let i = 0; i < px.length; i += STEP) {
      const d = shift[(i / 4) % shift.length];
      px[i] = Math.max(0, Math.min(255, px[i] + d));
    }
    return data;
  };

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    try {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 16 && this.height > 16) {
        ctx.fillStyle = 'rgba(' + (shift[0] + 1) + ',' + (shift[1] + 1) + ',' + (shift[2] + 1) + ',0.003)';
        ctx.fillRect(0, 0, 1, 1);
      }
    } catch (e) {}
    return origToDataURL.apply(this, args);
  };

  const patchGL = (proto) => {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === 37445) return 'Google Inc. (Intel)';
      if (p === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)';
      return orig.call(this, p);
    };
  };
  patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  const origGetChannel = AudioBuffer.prototype.getChannelData;
  AudioBuffer.prototype.getChannelData = function (ch) {
    const out = origGetChannel.call(this, ch);
    for (let i = 0; i < out.length; i += 1000) out[i] += shift[i % shift.length] * 1e-7;
    return out;
  };
})();
`;

export async function browserWsUrl(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const url = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).webSocketDebuggerUrl);
          } catch {
            resolve('');
          }
        });
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    });
    if (url) return url;
    await new Promise((r) => setTimeout(r, 250));
  }
  return '';
}

/**
 * 连上浏览器，对每个新开的页面下发补丁。返回一个断开函数。
 * @param {'screen'|'full'} mode
 */
export async function attachPatches(port, fp, uaString, mode = 'screen') {
  const wsUrl = await browserWsUrl(port);
  if (!wsUrl) throw new Error('连不上浏览器调试端口，补丁未生效');

  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  let msgId = 0;
  const send = (method, params, sessionId) =>
    ws.send(JSON.stringify({ id: ++msgId, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }));

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  // flatten 模式下每个新 target 会回一个 sessionId，我们对它单独下发补丁
  send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.method !== 'Target.attachedToTarget') return;

    const sid = msg.params.sessionId;
    const type = msg.params.targetInfo?.type;
    if (type !== 'page' && type !== 'iframe') {
      send('Runtime.runIfWaitingForDebugger', {}, sid);
      return;
    }

    if (fp.screen?.w && fp.screen?.h) {
      // 宽高传 0 = 不覆盖视口，只改 screen.*，页面布局和窗口尺寸都不受影响
      send('Emulation.setDeviceMetricsOverride', {
        width: 0,
        height: 0,
        deviceScaleFactor: 0,
        mobile: false,
        screenWidth: fp.screen.w,
        screenHeight: fp.screen.h,
        positionX: 0,
        positionY: 0,
      }, sid);
    }

    if (mode === 'full') {
      send('Page.enable', {}, sid);
      send('Emulation.setTimezoneOverride', { timezoneId: fp.timezone }, sid);
      send('Emulation.setLocaleOverride', { locale: fp.lang }, sid);
      send('Emulation.setUserAgentOverride', {
        userAgent: uaString,
        acceptLanguage: fp.acceptLang,
        platform: fp.platform === 'macos' ? 'MacIntel' : fp.platform === 'linux' ? 'Linux x86_64' : 'Win32',
      }, sid);
      send('Page.addScriptToEvaluateOnNewDocument', { source: patchScript(fp) }, sid);
    }

    send('Runtime.runIfWaitingForDebugger', {}, sid);
  });

  ws.on('error', () => {});

  return () => {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  };
}
