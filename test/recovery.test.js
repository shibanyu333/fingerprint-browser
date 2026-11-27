import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const project = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);

test('deleted environments keep their original storage across restart, import and restore', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-recovery-'));
  let service;

  async function stop() {
    if (service && service.exitCode === null && service.signalCode === null) {
      const exit = once(service, 'exit');
      service.kill('SIGTERM');
      await exit;
    }
  }
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  await cp(path.join(project, 'server'), path.join(root, 'server'), { recursive: true });
  await cp(path.join(project, 'package.json'), path.join(root, 'package.json'));
  await symlink(path.join(project, 'node_modules'), path.join(root, 'node_modules'), 'dir');

  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const base = 'http://127.0.0.1:' + port + '/api';
  const env = { ...process.env, PORT: String(port) };

  async function start() {
    service = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: 'ignore' });
    for (let i = 0; i < 300 && service.exitCode === null; i++) {
      if (await fetch(base + '/health').then((r) => r.ok, () => false)) return;
      await delay(100);
    }
    throw new Error('临时管理端启动失败');
  }
  async function request(method, route, body) {
    const res = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.ok, true, route + ' HTTP ' + res.status);
    return res.json();
  }
  async function cli(...args) {
    const result = await run(process.execPath, [path.join(project, 'bin/fingerprint-browser.js'), ...args, '--json'], { env });
    return JSON.parse(result.stdout);
  }

  await start();
  const { group } = await request('POST', '/groups', { name: '临时组' });
  const { created: [profile] } = await request('POST', '/profiles', { name: '恢复测试', group: group.id });
  const dir = path.join(root, 'profiles', profile.id);
  await mkdir(dir);
  await writeFile(path.join(dir, 'marker'), 'original');
  await request('DELETE', '/profiles/' + profile.id);
  await stop();
  await start();

  assert.deepEqual((await cli('list')).data.list, []);
  const [archived] = (await cli('trash')).profiles;
  assert.deepEqual(Object.keys(archived).sort(), ['deletedAt', 'id', 'name']);
  assert.equal(archived.id, profile.id);
  assert.deepEqual((await request('GET', '/export')).profiles, []);
  await request('DELETE', '/groups/' + group.id);
  const { id, name, fingerprint } = profile;
  await request('POST', '/import', { profiles: [{ id: id.toUpperCase(), name, fingerprint }] });
  const [imported] = (await cli('list')).data.list;
  assert.notEqual(imported.user_id.toLowerCase(), id.toLowerCase());

  assert.equal((await cli('restore', id)).id, id);
  const restored = (await cli('list')).data.list.find((p) => p.user_id === id);
  assert.equal(restored.name, name);
  assert.equal(restored.group_id, 'default');
  assert.equal(await readFile(path.join(dir, 'marker'), 'utf8'), 'original');
  assert.deepEqual((await cli('trash')).profiles, []);
  assert.equal((await fetch(base + '/trash/' + id + '/restore', { method: 'POST' })).status, 404);
  await request('DELETE', '/profiles/' + id + '?purge=1');
  await assert.rejects(readFile(path.join(dir, 'marker')), { code: 'ENOENT' });
  assert.deepEqual((await cli('trash')).profiles, []);
});
