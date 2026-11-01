import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { imageExtension } from './images.js';

// The dedicated image host stays responsive where the main one stalls, but serves no account routes.
const IMAGE_BASE = 'https://image-api.1route.dev', ACCOUNT_BASE = 'https://api.1route.dev';
const ATTEMPTS = 3, RETRY_MS = 1000;
const OPENAI_MODEL = 'openai/gpt-image-2.5-flare', GOOGLE_MODEL = 'google/gemini-3.1-flash-image';
const SIZES = { square: ['1024x1024', '1:1'], portrait: ['1024x1536', '2:3'], landscape: ['1536x1024', '3:2'] };
const DEFAULT_TIMEOUT_SECONDS = 300, MAX_TIMEOUT_SECONDS = 600, POLL_ERROR_LIMIT = 10;
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
const OPEN_PHASES = ['queued', 'running'];

export const imageDataURL = bytes => `data:${IMAGE_TYPES[imageExtension(bytes)] || 'image/png'};base64,${bytes.toString('base64')}`;

function requestError(status, data) {
  const code = data?.error?.code, message = String(data?.error?.message || '').slice(0, 200);
  if (status === 401) return new Error('生图 Key 无效，请到连接设置检查');
  if (code === 'insufficient_balance' || /insufficient.balance/i.test(message)) return new Error('生图余额不足，请到 https://www.1route.dev/purchase 充值');
  if (status === 429) return new Error('生图额度或并发已达上限，请稍后再试');
  return new Error(`生图失败（HTTP ${status}）${message ? '：' + message : ''}`);
}
async function request(route, { apiKey, fetcher, signal, base = IMAGE_BASE, method = 'GET', body, headers, timeout = 20000 }) {
  const res = await fetcher(base + route, { method, redirect: 'error', credentials: 'omit',
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(timeout)]),
    headers: { Authorization: `Bearer ${apiKey}`, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(requestError(res.status, data), { status: res.status });
  return data;
}
// Every call here is safe to repeat: reads have no effect, and a submit carries an idempotency key.
async function call(route, { attempts = ATTEMPTS, retryMs = RETRY_MS, ...options }) {
  for (let attempt = 1; ; attempt++) {
    try { return await request(route, options); }
    catch (e) {
      if (options.signal?.aborted || (e.status && e.status < 500)) throw e;
      if (attempt >= attempts) throw e.status ? e : new Error(e.name === 'TimeoutError' ? '生图服务响应超时，请稍后重试' : '无法连接生图服务，请检查网络后重试');
      await delay(retryMs * attempt, undefined, { signal: options.signal });
    }
  }
}
// Reads the key and balance only; it never submits a paid image job.
export async function checkImageKey(apiKey, { fetcher = fetch, signal, retryMs } = {}) {
  if (!apiKey) throw new Error('请先在连接设置中填写生图 Key');
  const options = { apiKey, fetcher, signal, retryMs, base: ACCOUNT_BASE };
  const key = await call('/v1/key/validate', options);
  if (!key?.isValid || key.key?.status !== 'active' || key.group?.status !== 'active') throw new Error('生图 Key 不可用，请检查是否已停用或过期');
  const usage = await call('/v1/usage', options).catch(() => null);
  return { group: key.group.name, platform: key.group.platform, balance: usage?.balance ?? usage?.remaining ?? null, unit: usage?.unit || '' };
}
export function jobRequest({ platform, prompt, orientation = 'square', reference, compact }) {
  const [size, ratio] = SIZES[orientation] || SIZES.square;
  const dimensions = platform === 'openai' ? { model: OPENAI_MODEL, size, ...(compact ? { output_format: 'jpeg' } : {}) } : { model: GOOGLE_MODEL, resolution: '1K', aspect_ratio: ratio };
  return { ...dimensions, prompt, ...(reference ? { images: [{ dataUrl: imageDataURL(reference) }] } : {}) };
}
async function settle(job, options, { pollMs, now }) {
  const route = `/api/v1/images/jobs/${encodeURIComponent(job.jobId)}`;
  const seconds = Math.min(MAX_TIMEOUT_SECONDS, Number(job.durationGuidance?.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS);
  const deadline = now() + seconds * 1000;
  let snapshot = job, failures = 0;
  try {
    while (OPEN_PHASES.includes(snapshot.phase)) {
      if (now() > deadline) throw new Error('生图超时，这张图可能仍在生成，未重复提交');
      await delay(pollMs, undefined, { signal: options.signal });
      // A failed status read says nothing about the job, so it must never cause a second submit.
      try { snapshot = await call(route, { ...options, attempts: 1 }); failures = 0; }
      catch (e) { if (options.signal?.aborted || ++failures >= POLL_ERROR_LIMIT) throw e; }
    }
  } catch (e) {
    if (options.signal?.aborted) await call(route, { ...options, signal: undefined, attempts: 1, method: 'DELETE' }).catch(() => {});
    throw e;
  }
  if (snapshot.phase !== 'completed') throw new Error(`生图未完成：${String(snapshot.error?.message || snapshot.phase).slice(0, 200)}`);
  return call(`${route}/result?response_format=base64`, { ...options, timeout: 120000 });
}
export async function generateImage({ apiKey, platform, prompt, orientation, reference, compact, idempotencyKey = randomUUID() }, { fetcher = fetch, signal, pollMs = 2000, retryMs, now = Date.now } = {}) {
  const options = { apiKey, fetcher, signal, retryMs };
  const body = jobRequest({ platform, prompt, orientation, reference, compact });
  const job = await call(`/api/v1/images/${reference ? 'edits' : 'generations'}/jobs`, { ...options, method: 'POST', body, timeout: 60000,
    headers: { 'Idempotency-Key': idempotencyKey } });
  const result = await settle(job, options, { pollMs, now });
  const encoded = result?.images?.[0]?.base64;
  if (!encoded) throw new Error('生图服务没有返回图片');
  const bytes = Buffer.from(encoded, 'base64');
  imageExtension(bytes); // Rejects anything that is not a real image before it reaches WeChat.
  return bytes;
}
