#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function serviceUrl(value = process.env.ASSISTANT_URL || 'http://127.0.0.1:4317') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('ASSISTANT_URL 必须是本机 HTTP 地址，例如 http://127.0.0.1:4317');
  }
  return url.origin;
}
export async function request(path, payload, base = serviceUrl()) {
  const response = await fetch(`${serviceUrl(base)}${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: payload === undefined ? {} : { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `服务返回 HTTP ${response.status}`);
  return result;
}
export async function submitRequest(text, conversationId, base) {
  if (!conversationId) {
    const conversation = await request('/api/conversations', {}, base);
    conversationId = conversation.id;
  }
  return request(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { text, requestId: randomUUID() }, base);
}
export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  let result;
  const need = (value, label) => { if (!value?.trim()) throw new Error(`缺少${label}`); return value; };
  if (command === 'ask') {
    const flag = rest.indexOf('--conversation');
    const conversation = flag < 0 ? undefined : need(rest[flag + 1], '会话 ID');
    const words = flag < 0 ? rest : [...rest.slice(0, flag), ...rest.slice(flag + 2)];
    result = await submitRequest(need(words.join(' '), '任务要求'), conversation);
  } else if (command === 'tasks') {
    result = (await request('/api/state')).tasks;
  } else if (command === 'task') {
    result = await request(`/api/tasks/${encodeURIComponent(need(rest[0], '任务 ID'))}`);
  } else if (command === 'followup') {
    result = await request(`/api/tasks/${encodeURIComponent(need(rest[0], '任务 ID'))}/messages`, { text: need(rest.slice(1).join(' '), '补充要求'), requestId: randomUUID() });
  } else if (command === 'stop') {
    result = await request(`/api/tasks/${encodeURIComponent(need(rest[0], '任务 ID'))}/actions`, { action: 'stop' });
  } else {
    throw new Error('用法：client.mjs ask "要求" [--conversation ID] | tasks | task ID | followup ID "补充" | stop ID');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
