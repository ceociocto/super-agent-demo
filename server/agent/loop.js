function fail(message, code) { return Object.assign(new Error(message), { code }); }
function checkSchema(value, schema = {}, path = '参数', depth = 0) {
  if (depth > 20) throw new Error('工具参数嵌套过深');
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error(`${path} 不在允许值中`);
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (types.length && !types.some(matches)) throw new Error(`${path} 类型应为 ${types.join('/')}`);
  if (typeof value === 'string' && ((schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.minLength !== undefined && value.length < schema.minLength))) throw new Error(`${path} 长度不符合要求`);
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw new Error(`${path} 超出范围`);
  if (Array.isArray(value)) {
    if ((schema.maxItems !== undefined && value.length > schema.maxItems) || (schema.minItems !== undefined && value.length < schema.minItems)) throw new Error(`${path} 项数不符合要求`);
    value.forEach((item, i) => checkSchema(item, schema.items, `${path}[${i}]`, depth + 1));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${path} 缺少 ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`${path} 包含无效属性`);
      if (Object.hasOwn(schema.properties || {}, key)) checkSchema(item, schema.properties[key], `${path}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) throw new Error(`${path} 包含未知属性 ${key}`);
    }
  }
}

export async function runAgent({ model, messages, tools = [], signal, maxSteps = 24, onEvent = async () => {}, checkpoint = async () => {}, beforeStep = async () => [], context = {} }) {
  if (!model?.complete || !Array.isArray(messages) || !Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new TypeError('无效 Agent 配置');
  const registry = new Map(tools.map(tool => [tool.name, tool]));
  if (registry.size !== tools.length) throw new TypeError('工具名称不能重复');
  const definitions = tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, complete: true };
  const append = async message => { messages.push(message); await checkpoint(messages); };
  const aborted = () => signal?.throwIfAborted();
  const executionContext = { ...context, signal };
  for (let step = 1; step <= maxSteps; step += 1) {
    aborted();
    const added = await beforeStep();
    if (added?.length) {
      // Inbox delivery is a batch: never overwrite durable claimed inputs with
      // only the first message if a checkpoint or process fails mid-delivery.
      messages.push(...added);
      await checkpoint(messages);
    }
    aborted();
    await onEvent({ type: 'model.start', step, model: model.model });
    let response;
    try { response = await model.complete({ messages, tools: definitions, signal }); }
    catch (error) {
      // The transport normalizes public errors, but third-party models may not.
      // Keep diagnostics structural so keys, request bodies, and private text cannot leak.
      await onEvent({ type: 'model.error', step, model: model.model, code: /^MODEL_[A-Z_]+$/.test(error.code || '') ? error.code : (signal?.aborted ? 'ABORTED' : 'MODEL_FAILED') });
      throw error;
    }
    aborted();
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
      const n = response.usage?.[key];
      if (Number.isSafeInteger(n) && n >= 0 && totals[key] !== null) totals[key] += n;
      else { totals[key] = null; totals.complete = false; }
    }
    await onEvent({ type: 'model.end', step, model: response.model || model.model, requestId: response.requestId || null, usage: response.usage || null });
    const message = response.message;
    if (!message || message.role !== 'assistant' || (!message.tool_calls?.length && !message.content?.trim())) throw fail('模型未返回有效回答', 'AGENT_OUTPUT');
    await append(message);
    if (message.content?.trim()) await onEvent({ type: 'assistant', step, text: message.content });
    const calls = message.tool_calls || [];
    if (!calls.length) return { text: message.content, steps: step, usage: totals };
    let cancellation;
    for (const call of calls) {
      let args, result;
      const name = call.function.name;
      if (signal?.aborted || cancellation || context.shouldStop?.()) {
        result = { error: signal?.aborted || cancellation ? '执行已取消；此工具未执行' : '任务已交接；此工具未执行', skipped: true };
        if (signal?.aborted) cancellation = signal.reason || new DOMException('已取消', 'AbortError');
      } else {
        try {
          args = JSON.parse(call.function.arguments);
          const tool = registry.get(name);
          if (!tool) throw new Error(`未知工具 ${name}`);
          checkSchema(args, tool.parameters);
          await onEvent({ type: 'tool.start', step, callId: call.id, name, args });
          result = await tool.execute(args, { ...executionContext, toolCallId: call.id });
          if (result === undefined) result = { ok: true };
          // Check serializability before committing a tool response.
          JSON.stringify(result);
          if (signal?.aborted) cancellation = signal.reason || new DOMException('已取消', 'AbortError');
        } catch (error) {
          if (signal?.aborted || error.name === 'AbortError') cancellation = signal?.reason || error;
          result = { error: cancellation ? '执行已取消；可能已产生部分结果，继续前应检查实际状态' : String(error.message || '工具执行失败').slice(0, 2000) };
        }
      }
      await append({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      await onEvent({ type: 'tool.end', step, callId: call.id, name, ...(args !== undefined ? { args } : {}), result });
    }
    if (cancellation) throw cancellation;
    aborted();
    if (context.shouldStop?.()) return { text: message.content || '', steps: step, usage: totals };
  }
  throw fail(`已达到本轮 ${maxSteps} 次模型调用上限；任务尚未完成，可检查后继续`, 'AGENT_STEP_LIMIT');
}
