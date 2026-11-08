#!/usr/bin/env node
// A local stdio adapter; the independently started web service owns all tasks.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { request, serviceUrl, submitRequest } from './client.mjs';

const text = { type: 'string', minLength: 1, maxLength: 16000 };
const id = { type: 'string', minLength: 1, maxLength: 200 };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const toolDefinitions = [
  { name: 'submit_request', description: '向个人助理提交自由任务或总聊天跟进。立即返回收件信息，Router 异步协调；随后用 list_tasks 查询。省略 conversationId 会创建新会话。', inputSchema: schema({ text, conversationId: id }, ['text']) },
  { name: 'list_tasks', description: '列出与网页共享的任务、进度、结果摘要。', inputSchema: schema({}) },
  { name: 'get_task', description: '读取任务完整消息、执行历史、实际工具输出与产物。', inputSchema: schema({ taskId: id }, ['taskId']) },
  { name: 'followup_task', description: '向指定原任务补充要求，保留上下文与任务身份。', inputSchema: schema({ taskId: id, text }, ['taskId', 'text']) },
  { name: 'stop_task', description: '停止指定任务；不会撤销已经发生的文件或 GitHub 操作。', inputSchema: schema({ taskId: id }, ['taskId']) },
];
function validate(definition, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
  for (const key of definition.inputSchema.required) if (!(key in args)) throw new Error(`缺少参数 ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = definition.inputSchema.properties[key];
    if (!rule) throw new Error(`未知参数 ${key}`);
    if (typeof value !== 'string' || !value.trim() || value.length > rule.maxLength) throw new Error(`参数 ${key} 必须是非空字符串，最多 ${rule.maxLength} 字符`);
  }
}
export async function handleMessage(message, base = serviceUrl()) {
  const hasId = Object.hasOwn(message || {}, 'id');
  const failure = (code, description) => ({ jsonrpc: '2.0', id: hasId ? message.id : null, error: { code, message: description } });
  if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (hasId && message.id !== null && !['number', 'string'].includes(typeof message.id))) return failure(-32600, 'Invalid Request');
  if (!hasId) return null;
  const ok = result => ({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') return ok({ protocolVersion: ['2024-11-05', '2025-03-26'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'personal-multitask-assistant', version: '0.4.0' }, instructions: '与本机网页共享任务。提交立即返回，不代表任务已完成；查询任务实际状态和工具证据。' });
  if (message.method === 'ping') return ok({});
  if (message.method === 'tools/list') return ok({ tools: toolDefinitions });
  if (message.method !== 'tools/call') return failure(-32601, 'Method not found');
  const definition = toolDefinitions.find(tool => tool.name === message.params?.name);
  if (!definition) return failure(-32602, 'Unknown tool');
  const args = message.params.arguments ?? {};
  try { validate(definition, args); } catch (error) { return failure(-32602, error.message); }
  try {
    let result;
    if (definition.name === 'submit_request') result = await submitRequest(args.text, args.conversationId, base);
    else if (definition.name === 'list_tasks') { const state = await request('/api/state', undefined, base); result = { tasks: state.tasks, model: state.model, metrics: state.metrics }; }
    else if (definition.name === 'get_task') result = await request(`/api/tasks/${encodeURIComponent(args.taskId)}`, undefined, base);
    else if (definition.name === 'followup_task') result = await request(`/api/tasks/${encodeURIComponent(args.taskId)}/messages`, { text: args.text, requestId: randomUUID() }, base);
    else result = await request(`/api/tasks/${encodeURIComponent(args.taskId)}/actions`, { action: 'stop' }, base);
    return ok({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
  } catch (error) {
    return ok({ content: [{ type: 'text', text: `本机助理请求失败：${error.message}。请确认网页服务已启动。` }], isError: true });
  }
}
export function runStdio() {
  const base = serviceUrl();
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Serialize incoming calls so a follow-up cannot overtake task creation.
  let pending = Promise.resolve();
  reader.on('line', line => {
    if (!line.trim()) return;
    pending = pending.then(async () => {
      let result;
      try {
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('request too large');
        result = await handleMessage(JSON.parse(line), base);
      } catch { result = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
      if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch(error => { process.stderr.write(`MCP error: ${error.message}\n`); });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runStdio(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
