// 本地代理中继。
//
// 存在的理由：Chromium 的 --proxy-server 不支持带用户名密码的代理认证
// （官方文档明确写了 "password authentication not supported"）。而电商用的
// 住宅/静态 IP 几乎全是 user:pass 认证的 SOCKS5。
//
// 解决办法：每个环境启动一个只监听 127.0.0.1 的 HTTP 代理，浏览器连它（无需认证），
// 由它把流量转给上游 SOCKS5/HTTP 代理并在这一层完成认证。
//
// 顺带解决 DNS 泄露：浏览器发过来的是 CONNECT example.com:443（域名而非 IP），
// 域名解析发生在上游代理出口，本机不会去查 DNS。

import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { SocksClient } from 'socks';

const CONNECT_TIMEOUT = 30000;

export function normalizeUpstream(proxy) {
  if (!proxy || !proxy.type || proxy.type === 'direct' || !proxy.host) return null;
  return {
    type: String(proxy.type).toLowerCase(),
    host: String(proxy.host).trim(),
    port: Number(proxy.port),
    username: proxy.username || '',
    password: proxy.password || '',
  };
}

/** 打开一条到目标地址的隧道，认证在这里做掉 */
export function connectThrough(up, host, port) {
  const target = { host, port: Number(port) };
  if (!up) return directConnect(target);
  if (up.type === 'socks5' || up.type === 'socks4' || up.type === 'socks') {
    return socksConnect(up, target);
  }
  if (up.type === 'http' || up.type === 'https') {
    return httpProxyConnect(up, target);
  }
  return Promise.reject(new Error(`不支持的代理类型: ${up.type}`));
}

function directConnect({ host, port }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const onErr = (e) => {
      sock.destroy();
      reject(e);
    };
    sock.setTimeout(CONNECT_TIMEOUT, () => onErr(new Error('连接超时')));
    sock.once('error', onErr);
    sock.once('connect', () => {
      sock.setTimeout(0);
      sock.removeListener('error', onErr);
      resolve(sock);
    });
  });
}

async function socksConnect(up, target) {
  const type = up.type === 'socks4' ? 4 : 5;
  const info = await SocksClient.createConnection({
    proxy: {
      host: up.host,
      port: up.port,
      type,
      // socks 库用 userId/password 传认证；socks4 只有 userId
      ...(up.username ? { userId: up.username } : {}),
      ...(up.password && type === 5 ? { password: up.password } : {}),
    },
    command: 'connect',
    destination: target,
    timeout: CONNECT_TIMEOUT,
  });
  return info.socket;
}

function httpProxyConnect(up, target) {
  return new Promise((resolve, reject) => {
    const opts = { host: up.host, port: up.port };
    const sock = up.type === 'https'
      ? tls.connect({ ...opts, servername: up.host, rejectUnauthorized: false })
      : net.connect(opts);

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err);
    };
    sock.setTimeout(CONNECT_TIMEOUT, () => fail(new Error('上游代理连接超时')));
    sock.once('error', fail);

    sock.once(up.type === 'https' ? 'secureConnect' : 'connect', () => {
      const hostport = `${target.host}:${target.port}`;
      let head = `CONNECT ${hostport} HTTP/1.1\r\nHost: ${hostport}\r\n`;
      if (up.username) {
        const cred = Buffer.from(`${up.username}:${up.password}`).toString('base64');
        head += `Proxy-Authorization: Basic ${cred}\r\n`;
      }
      head += 'Proxy-Connection: keep-alive\r\n\r\n';
      sock.write(head);

      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) {
          if (buf.length > 65536) fail(new Error('上游代理响应异常'));
          return;
        }
        sock.removeListener('data', onData);
        const status = Number(buf.toString('latin1', 0, end).split(' ')[1]);
        if (status !== 200) return fail(new Error(`上游代理拒绝连接 (HTTP ${status})`));
        // CONNECT 响应之后可能已经粘了一段真实数据，塞回流里别丢
        const leftover = buf.subarray(end + 4);
        if (leftover.length) sock.unshift(leftover);
        settled = true;
        sock.setTimeout(0);
        sock.removeListener('error', fail);
        resolve(sock);
      };
      sock.on('data', onData);
    });
  });
}

export class Relay {
  constructor(upstream, label = '') {
    this.upstream = normalizeUpstream(upstream);
    this.label = label;
    this.port = 0;
    this.server = null;
    this.sockets = new Set();
    this.stats = { up: 0, down: 0, conns: 0, errors: 0, lastError: '' };
  }

  listen() {
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      this.server = server;

      server.on('connect', (req, clientSocket, head) => this.#onConnect(req, clientSocket, head));
      server.on('request', (req, res) => this.#onRequest(req, res));
      server.on('connection', (s) => {
        this.sockets.add(s);
        s.once('close', () => this.sockets.delete(s));
      });
      server.on('clientError', (_err, sock) => sock.destroy());
      server.once('error', reject);

      // 只绑 127.0.0.1：绝不能变成一个对外开放的开放代理
      server.listen(0, '127.0.0.1', () => {
        this.port = server.address().port;
        resolve(this.port);
      });
    });
  }

  #count(err) {
    this.stats.errors += 1;
    this.stats.lastError = String(err?.message || err).slice(0, 200);
  }

  async #onConnect(req, clientSocket, head) {
    const [host, portStr] = splitHostPort(req.url);
    this.stats.conns += 1;
    try {
      const remote = await connectThrough(this.upstream, host, portStr || 443);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: fpb-relay\r\n\r\n');
      if (head && head.length) remote.write(head);

      remote.on('data', (c) => { this.stats.down += c.length; });
      clientSocket.on('data', (c) => { this.stats.up += c.length; });

      const kill = () => { remote.destroy(); clientSocket.destroy(); };
      remote.on('error', kill);
      clientSocket.on('error', kill);
      remote.pipe(clientSocket);
      clientSocket.pipe(remote);
    } catch (err) {
      this.#count(err);
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
      }
    }
  }

  async #onRequest(req, res) {
    // 浏览器把明文 HTTP 请求以绝对 URI 发给代理
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    this.stats.conns += 1;
    try {
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
      const socket = await connectThrough(this.upstream, url.hostname, port);
      const headers = { ...req.headers };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];

      const proxied = http.request({
        createConnection: () => socket,
        method: req.method,
        path: url.pathname + url.search,
        headers,
        setHost: false,
      });
      req.on('data', (c) => { this.stats.up += c.length; });
      proxied.on('response', (up) => {
        up.on('data', (c) => { this.stats.down += c.length; });
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      proxied.on('error', (err) => {
        this.#count(err);
        if (!res.headersSent) res.writeHead(502);
        res.end();
        socket.destroy();
      });
      req.pipe(proxied);
    } catch (err) {
      this.#count(err);
      if (!res.headersSent) res.writeHead(502);
      res.end(`relay error: ${err.message}`);
    }
  }

  close() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

function splitHostPort(str) {
  const i = str.lastIndexOf(':');
  if (i === -1) return [str, ''];
  return [str.slice(0, i), str.slice(i + 1)];
}
