#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isProfileId } from '../server/store.js';

const commands = {
  health: { description: '检查本机管理端', path: '/api/health' },
  list: { description: '列出环境 ID、运行状态和名称', path: '/api/v1/user/list' },
  start: { description: '按 GUI 中的设置打开环境', path: '/api/profiles/:id/launch', method: 'POST' },
  connect: { description: '获取已开启自动化的运行环境的本机 CDP 地址', path: '/api/profiles/:id/connection' },
  stop: { description: '关闭环境', path: '/api/profiles/:id/close', method: 'POST' },
  trash: { description: '列出回收站中的环境', path: '/api/trash' },
  restore: { description: '按原 ID 和数据目录恢复环境', path: '/api/trash/:id/restore', method: 'POST' },
};

function printHelp(json) {
  const entries = Object.entries(commands).map(([name, { description, path }]) => ({
    name, arguments: path.includes(':id') ? ['id'] : [], description,
  }));
  if (json) return console.log(JSON.stringify({ commands: entries, options: ['--port', '--json', '--help'] }));
  console.log('用法：fingerprint-browser <命令> [--port 端口] [--json]');
  for (const entry of entries) {
    const usage = entry.arguments.length ? entry.name + ' <ID>' : entry.name;
    console.log('  ' + usage.padEnd(15) + entry.description);
  }
  console.log('先打开桌面 App 或运行 npm start。端口默认取 PORT 环境变量或 3131。');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      port: { type: 'string' },
    },
  });
  const [command, id] = positionals;
  if (values.help || !command) return printHelp(values.json);
  if (!Object.hasOwn(commands, command)) {
    throw new Error(`未知命令 ${command}，可用 --help 查看用法`);
  }
  const { path, method = 'GET' } = commands[command];
  const singleProfile = path.includes(':id');
  if (singleProfile && (positionals.length !== 2 || !isProfileId(id))) {
    throw new Error(`用法：${command} <环境 ID>，可用 ${command === 'restore' ? 'trash' : 'list'} 查看 ID`);
  }
  if (!singleProfile && positionals.length !== 1) throw new Error(`${command} 无需参数`);

  const port = values.port ?? process.env.PORT ?? '3131';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('端口必须是 1 至 65535 的整数');
  }
  const base = `http://127.0.0.1:${port}`;
  let response;
  try {
    response = await fetch(base + path.replace(':id', id), {
      method,
      redirect: 'error',
    });
  } catch (err) {
    throw new Error(`访问 ${base} 失败，请确认管理端已启动且端口正确（${err.cause?.code || err.message}）`);
  }
  const data = await response.json().catch(() => null);
  const success = command === 'list' ? data?.code === 0 : data?.ok === true;
  if (!response.ok || !success) {
    const error = new Error(data?.error || data?.message || data?.msg || `管理端响应异常（HTTP ${response.status}）`);
    if (!response.ok) error.httpStatus = response.status;
    throw error;
  }
  if (values.json) return console.log(JSON.stringify(data));
  if (command === 'list') {
    const rows = data.data.list;
    if (!rows.length) return console.log('暂无环境');
    console.log('ID\t状态\t名称');
    for (const row of rows) {
      const status = typeof row.running === 'boolean' ? (row.running ? '运行中' : '已关闭') : '未知';
      const name = String(row.name).replace(/[\x00-\x1f\x7f]/g, ' ');
      const warning = row.settingsWarning ? `（${row.settingsWarning}）` : '';
      console.log(`${row.user_id}\t${status}${warning}\t${name}`);
    }
  } else if (command === 'trash') {
    if (!data.profiles.length) return console.log('回收站为空');
    console.log('ID\t移入时间\t名称');
    for (const row of data.profiles) {
      console.log(`${row.id}\t${new Date(row.deletedAt).toLocaleString()}\t${String(row.name).replace(/[\x00-\x1f\x7f]/g, ' ')}`);
    }
  } else if (command === 'restore') {
    console.log(`已恢复环境 ${id}`);
  } else if (command === 'connect') {
    console.log(data.cdpUrl);
  } else if (command === 'health') {
    console.log(`管理端已就绪（${base}）`);
  } else {
    console.log(`${command === 'start' ? '已打开' : '已关闭'}环境 ${id}`);
  }
}

main().catch((err) => {
  console.error(process.argv.slice(2).includes('--json')
    ? JSON.stringify({ ok: false, error: err.message, httpStatus: err.httpStatus })
    : err.message);
  process.exitCode = 1;
});
