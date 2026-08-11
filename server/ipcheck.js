// 通过代理实际发一次请求，拿到出口 IP / 国家 / 时区 —— 打开环境前先确认代理是活的，
// 并且用返回的国家码把浏览器语言和时区对齐，避免「美国 IP + 上海时区」这种一眼假的组合。
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { connectThrough, normalizeUpstream } from './proxy-relay.js';

const FIELDS = 'status,message,query,country,countryCode,regionName,city,timezone,isp,org,proxy,hosting,mobile';

export async function checkProxy(proxyConfig, timeoutMs = 20000) {
  const up = normalizeUpstream(proxyConfig);
  const started = Date.now();

  // 第二个地理库用来交叉校验。不同库对同一个 IP 的判断经常不一致
  // （实测同一个 IP，ip-api 说纽约、BrowserScan 说洛杉矶），
  // 而电商平台用的是哪一家我们不知道 —— 有分歧就该让用户知道，换条干净的 IP。
  const [result, second] = await Promise.all([
    withTimeout(fetchJson(up, 'ip-api.com', 80, `/json/?fields=${FIELDS}`), timeoutMs),
    withTimeout(fetchJsonTls(up, 'ipwho.is', '/?fields=ip,country_code,city,timezone'), 12000).catch(() => null),
  ]);
  const latency = Date.now() - started;

  if (!result || result.status === 'fail') {
    throw new Error(result?.message || '代理返回了无法解析的内容');
  }

  const secondTz = second?.timezone?.id || '';
  const crossCheck = second
    ? {
      source: 'ipwho.is',
      timezone: secondTz,
      city: second.city || '',
      countryCode: second.country_code || '',
      // 只有时区真的不同才算冲突：城市名各家写法不一，不能拿来判断
      conflict: !!(secondTz && secondTz !== result.timezone),
    }
    : null;

  return {
    crossCheck,
    ok: true,
    ip: result.query,
    country: result.country,
    countryCode: result.countryCode,
    region: result.regionName,
    city: result.city,
    timezone: result.timezone,
    isp: result.isp || result.org || '',
    // ip-api 自己的风险标记：数据中心 IP 在电商平台上更容易被盯上
    flaggedProxy: !!result.proxy,
    hosting: !!result.hosting,
    mobile: !!result.mobile,
    latency,
    checkedAt: Date.now(),
  };
}

function fetchJson(up, host, port, path) {
  return new Promise((resolve, reject) => {
    connectThrough(up, host, port).then((socket) => {
      const req = http.request(
        {
          createConnection: () => socket,
          host,
          port,
          path,
          method: 'GET',
          headers: { Host: host, 'User-Agent': 'curl/8.4.0', Accept: 'application/json', Connection: 'close' },
          setHost: false,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            socket.destroy();
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error(`响应不是 JSON（HTTP ${res.statusCode}）`));
            }
          });
        },
      );
      req.on('error', (e) => {
        socket.destroy();
        reject(e);
      });
      req.end();
    }).catch(reject);
  });
}

/** 走代理发一个 HTTPS 请求：先隧道到目标，再在隧道上做 TLS 握手 */
function fetchJsonTls(up, host, path) {
  return new Promise((resolve, reject) => {
    connectThrough(up, host, 443).then((socket) => {
      // 隧道拿到的是裸 TCP，要自己在上面握 TLS；TLSSocket 会缓冲握手完成前的写入
      const secure = tls.connect({ socket, servername: host });
      secure.on('error', (e) => { socket.destroy(); reject(e); });

      const req = https.request(
        {
          createConnection: () => secure,
          servername: host,
          host,
          port: 443,
          path,
          method: 'GET',
          headers: { Host: host, 'User-Agent': 'curl/8.4.0', Accept: 'application/json', Connection: 'close' },
          setHost: false,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            secure.destroy();
            socket.destroy();
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error('交叉校验返回的不是 JSON'));
            }
          });
        },
      );
      req.on('error', (e) => { secure.destroy(); socket.destroy(); reject(e); });
      req.end();
    }).catch(reject);
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`代理检测超时（${ms / 1000}s）`)), ms)),
  ]);
}
