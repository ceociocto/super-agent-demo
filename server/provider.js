// Fixed official endpoint. No configurable base URL, tools, or execution capabilities.
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';

export function createProviderFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  const provider = env.MODEL_PROVIDER || 'simulation';
  if (provider === 'simulation') return null;
  if (provider !== 'deepseek') throw new Error('MODEL_PROVIDER 仅支持 simulation 或 deepseek。');
  if (!env.DEEPSEEK_API_KEY?.trim()) throw new Error('启用 DeepSeek 必须在环境变量中设置 DEEPSEEK_API_KEY；不会降级为模拟模式。');
  const apiKey = env.DEEPSEEK_API_KEY.trim();
  const model = env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash';
  if (model.length > 100 || !/^[A-Za-z0-9_.:-]+$/.test(model)) throw new Error('DEEPSEEK_MODEL 格式不正确。');
  return {
    name: 'deepseek', model,
    async generate({ messages, signal, maxTokens }) {
      const response = await fetchImpl(DEEPSEEK_ENDPOINT, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens, thinking: { type: 'disabled' } }),
      });
      if (!response.ok) {
        const error = new Error(`模型服务返回 HTTP ${response.status}；请检查服务配置后手动重试。`);
        error.code = 'PROVIDER_HTTP'; error.publicMessage = error.message; throw error;
      }
      const data = await response.json();
      const choice = data.choices?.[0];
      if (!choice || choice.finish_reason !== 'stop' || choice.message?.tool_calls?.length || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) {
        const error = new Error('模型返回无效或不完整的文本产物；未转入审批。');
        error.code = 'PROVIDER_OUTPUT'; error.publicMessage = error.message; throw error;
      }
      const number = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
      return { text: choice.message.content, usage: { inputTokens: number(data.usage?.prompt_tokens), outputTokens: number(data.usage?.completion_tokens), totalTokens: number(data.usage?.total_tokens) } };
    },
  };
}
