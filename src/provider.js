import { setTimeout as delay } from 'node:timers/promises';

export function completionsURL(baseUrl) {
  return baseUrl.replace(/\/+$/, '') + '/chat/completions';
}
const retryable = message => Object.assign(new Error(message), { retryable: true });
const hasImages = messages => messages.some(m => Array.isArray(m.content) && m.content.some(part => part.type === 'image_url'));

export class Provider {
  constructor(config, fetcher = fetch, { retryMs = 1000 } = {}) { this.config = config; this.fetcher = fetcher; this.retryMs = retryMs; }
  async complete(messages, tools, signal) {
    // Model calls have no local side effects, so transient failures are safe to repeat.
    for (let attempt = 0; ; attempt++) {
      try { return await this.request(messages, tools, signal); }
      catch (e) {
        if (!e.retryable || signal?.aborted || attempt >= 2) throw e;
        await delay(this.retryMs * 3 ** attempt, undefined, { signal });
      }
    }
  }
  async request(messages, tools, signal) {
    const c = this.config();
    const apiKey = c.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('请先在设置页填写模型 API Key');
    let res;
    try {
      res = await this.fetcher(completionsURL(c.baseUrl), {
        method: 'POST', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(120_000)]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: c.model, messages, ...(tools?.length ? { tools } : {}), stream: false }),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw retryable(e.name === 'TimeoutError' ? '模型请求超时，请稍后重试' : '无法连接模型服务，请检查网络和 API 地址');
    }
    if (res.status === 429 || res.status >= 500) throw retryable(`模型请求失败（HTTP ${res.status}），请稍后重试`);
    if (res.status === 400 && hasImages(messages)) throw new Error('模型拒绝了图片输入（HTTP 400）。如果当前模型不支持看图，请在设置中关闭「模型支持看图」');
    if (!res.ok) throw new Error(`模型请求失败（HTTP ${res.status}），请检查 Key、模型名称和账户状态`);
    let json;
    try { json = await res.json(); } catch { throw retryable('模型服务返回了无法解析的内容'); }
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
