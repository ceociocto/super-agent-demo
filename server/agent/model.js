import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_GLM_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';

function loadConfig(env) {
  const path = resolve(env.ASSISTANT_CONFIG || 'config.local.json');
  if (!existsSync(path)) {
    if (env.ASSISTANT_CONFIG) throw new Error('ASSISTANT_CONFIG 指定的配置文件不存在');
    return {};
  }
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('模型配置文件不是有效 JSON'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('模型配置必须是 JSON 对象');
  if (Object.hasOwn(config, 'apiKey') || Object.hasOwn(config, 'api_key')) throw new Error('配置文件仅允许 apiKeyEnv 引用环境变量，请勿保存密钥');
  return config;
}

function failure(message, code) { return Object.assign(new Error(message), { code }); }
function positive(value, fallback, name, max) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${name} 配置无效`);
  return n;
}

async function boundedJSON(response, limit, signal) {
  const declared = Number(response.headers?.get('content-length'));
  if (declared > limit) throw failure('模型响应超过大小限制', 'MODEL_OUTPUT_LIMIT');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); let bytes = 0; text = '';
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw failure('模型响应超过大小限制', 'MODEL_OUTPUT_LIMIT');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > limit) throw failure('模型响应超过大小限制', 'MODEL_OUTPUT_LIMIT');
  }
  try { return JSON.parse(text); } catch { throw failure('模型返回了无效 JSON', 'MODEL_OUTPUT'); }
}

function parseMessage(data) {
  const choice = data?.choices?.[0], source = choice?.message;
  if (choice?.finish_reason === 'length') throw failure('模型输出达到长度限制；本轮未执行工具，请提高 MODEL_MAX_TOKENS 后重试', 'MODEL_LENGTH');
  if (!source || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw failure('模型未返回完整回答或工具调用', 'MODEL_OUTPUT');
  const calls = source.tool_calls;
  if (calls !== undefined && (!Array.isArray(calls) || calls.length > 32)) throw failure('模型返回了无效工具调用', 'MODEL_OUTPUT');
  const message = { role: 'assistant', content: typeof source.content === 'string' ? source.content : null };
  if (calls?.length) {
    const ids = new Set();
    message.tool_calls = calls.map(call => {
      if (typeof call?.id !== 'string' || !call.id || ids.has(call.id) || call.type !== 'function' || typeof call.function?.name !== 'string' || !call.function.name || typeof call.function.arguments !== 'string') throw failure('模型返回了无效或重复工具调用', 'MODEL_OUTPUT');
      ids.add(call.id);
      return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
    });
  } else if (choice.finish_reason !== 'stop' || !message.content?.trim()) {
    throw failure('模型回答为空，未生成可交付结果', 'MODEL_OUTPUT');
  }
  // GLM requires the reasoning field to survive a tool round trip. It is not an activity event.
  if (typeof source.reasoning_content === 'string') message.reasoning_content = source.reasoning_content;
  return message;
}

export function createModel(env = process.env, { fetchImpl = globalThis.fetch, config = loadConfig(env) } = {}) {
  const keyEnv = config.apiKeyEnv || 'GLM_API_KEY';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw new Error('apiKeyEnv 配置无效');
  const key = env.MODEL_API_KEY?.trim() || env[keyEnv]?.trim() || '';
  const model = env.MODEL_NAME?.trim() || config.model || env.GLM_MODEL?.trim() || 'glm-5.3';
  if (typeof model !== 'string' || !/^[A-Za-z0-9_.:/-]{1,100}$/.test(model)) throw new Error('模型名称配置无效');
  let url;
  try { url = new URL(env.MODEL_BASE_URL || config.baseUrl || env.GLM_BASE_URL || DEFAULT_GLM_BASE_URL); } catch { throw new Error('模型 Base URL 配置无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('模型 Base URL 必须是不含凭证和查询参数的 HTTP(S) 地址');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('远程模型接口必须使用 HTTPS');
  const baseUrl = url.href.replace(/\/$/, '');
  const timeoutMs = positive(env.MODEL_TIMEOUT_MS ?? config.timeoutMs ?? env.GLM_TIMEOUT_MS, 120000, '模型 timeoutMs', 600000);
  const maxTokens = positive(env.MODEL_MAX_TOKENS ?? config.maxTokens ?? env.GLM_MAX_TOKENS, 8192, '模型 maxTokens', 131072);
  const glm = /^glm-/i.test(model);
  const effort = env.MODEL_REASONING_EFFORT || config.reasoningEffort || (glm ? env.GLM_REASONING_EFFORT : null) || (/^glm-5\.3/i.test(model) ? 'low' : null);
  if (effort && (typeof effort !== 'string' || !/^[a-z_]{1,30}$/.test(effort))) throw new Error('reasoningEffort 配置无效');
  const thinking = config.thinking === undefined ? (glm ? { type: 'enabled' } : null) : config.thinking;
  if (thinking !== null && (typeof thinking !== 'object' || !['enabled', 'disabled'].includes(thinking.type))) throw new Error('thinking 应为 null 或包含 type: enabled/disabled 的对象');
  const extraBody = config.extraBody || {};
  if (typeof extraBody !== 'object' || Array.isArray(extraBody) || Object.keys(extraBody).some(k => ['messages', 'tools', 'model', 'stream', 'tool_choice', 'api_key', 'authorization'].includes(k.toLowerCase()))) throw new Error('extraBody 不能覆盖模型、会话、工具或凭证字段');
  return {
    name: glm ? 'glm' : 'openai-compatible', model, baseUrl, configured: Boolean(key),
    async complete({ messages, tools = [], signal } = {}) {
      if (!key) throw failure(`未配置 MODEL_API_KEY 或 ${keyEnv}；请设置独立环境变量后启动，不会使用模拟回答`, 'MODEL_NOT_CONFIGURED');
      signal?.throwIfAborted();
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let timer;
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => { const error = failure('模型请求超时，请检查连接后重试', 'MODEL_TIMEOUT'); controller.abort(error); reject(error); }, timeoutMs);
      });
      const operation = async () => {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST', redirect: 'error', signal: combined,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ ...(thinking ? { thinking } : {}), ...(effort ? { reasoning_effort: effort } : {}), ...extraBody, model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), max_tokens: maxTokens, stream: false }),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw failure(`模型接口返回 HTTP ${response.status}；请检查端点、账号权限或额度`, 'MODEL_HTTP');
        }
        const data = await boundedJSON(response, 2 * 1024 * 1024, combined);
        const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
        return { message: parseMessage(data), usage: { inputTokens: number(data.usage?.prompt_tokens), outputTokens: number(data.usage?.completion_tokens), totalTokens: number(data.usage?.total_tokens) }, requestId: typeof data.id === 'string' ? data.id.slice(0, 200) : null, model: typeof data.model === 'string' ? data.model.slice(0, 100) : model };
      };
      try { return await Promise.race([operation(), expired]); }
      catch (error) {
        if (signal?.aborted) throw signal.reason || new DOMException('已取消', 'AbortError');
        if (error.code?.startsWith('MODEL_')) throw error;
        // Do not expose provider bodies, request headers, URLs from errors, or credentials.
        throw failure('模型连接失败，请检查网络及接口配置', 'MODEL_CONNECTION');
      } finally { clearTimeout(timer); }
    },
  };
}
