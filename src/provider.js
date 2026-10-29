export function completionsURL(baseUrl) {
  return baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

export class Provider {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; }
  async complete(messages, tools, signal) {
    const c = this.config();
    const apiKey = c.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('请先在设置页填写模型 API Key');
    const res = await this.fetcher(completionsURL(c.baseUrl), {
      method: 'POST', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(120_000)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: c.model, messages, ...(tools?.length ? { tools } : {}), stream: false }),
    });
    if (!res.ok) throw new Error(`模型请求失败（HTTP ${res.status}），请检查 Key、模型名称和账户状态`);
    const json = await res.json();
    const message = json.choices?.[0]?.message;
    if (!message || message.role !== 'assistant') throw new Error('模型没有返回有效的 assistant 消息');
    if (json.choices[0].finish_reason === 'length' && message.tool_calls?.length) throw new Error('模型工具参数被截断，本轮未执行');
    // Preserve reasoning_content for DeepSeek thinking + tool calling round trips.
    const result = { role: 'assistant', content: message.content ?? null };
    if (message.reasoning_content !== undefined) result.reasoning_content = message.reasoning_content;
    if (message.tool_calls?.length) {
      if (message.tool_calls.length > 12) throw new Error('单次工具调用过多，本轮未执行');
      const ids = new Set();
      for (const call of message.tool_calls) {
        if (!call?.id || ids.has(call.id) || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') throw new Error('模型返回了无效工具调用，本轮未执行');
        ids.add(call.id);
      }
      result.tool_calls = message.tool_calls;
    }
    return result;
  }
  async test(signal) {
    const reply = await this.complete([{ role: 'user', content: '请只回复：连接成功' }], [], signal);
    return reply.content || '模型已连接';
  }
}
