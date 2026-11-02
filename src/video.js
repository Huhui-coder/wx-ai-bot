import { setTimeout as delay } from 'node:timers/promises';

const BASE = 'https://pixstag.com/api/v2';
export const VIDEO_MODELS = ['doubao-seedance-2-5', 'doubao-seedance-2', 'MiniMax-H3'], DEFAULT_VIDEO_MODEL = VIDEO_MODELS[0];
const POLL_ERROR_LIMIT = 10, MAX_WAIT_MS = 600000, MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const MIN_SECONDS = 4, MAX_SECONDS = 15;
export const DIALOGUE_MAX_CHARS = 60, REFERENCE_TARGET_BYTES = 500000;
export const VOICE_SAMPLE_TEXT = '今天过得怎么样呀？我刚刚还在想你呢，晚上早点休息，别又熬夜了，好不好。';

// Speech runs near four characters a second; the rest leaves room for a pause and an expression.
export const videoSeconds = dialogue => Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.ceil(Array.from(dialogue).length / 4) + 2));

export function videoPrompt({ dialogue, acting, scene, appearance, style = 'real' }) {
  const look = appearance ? `，外貌：${appearance}；外貌文字和参考图不一致时以参考图为准` : '';
  const speech = `场景：${scene}。表演：${acting}。她用自然的语气说中文：「${dialogue}」。只说这一段台词，说话时嘴型与台词完全一致，语气有自然的停顿，声音音色与参考音频一致。`;
  // The text otherwise outweighs the reference image, so a drawn character must be named as drawn.
  if (style === 'anime') return `日系二次元动画风格的竖屏短视频，整段保持和参考图一样的动漫画风，不是真人，不要变成真人。参考图里的成年动漫角色就是主角（画风、脸、发型发色、瞳色和配饰都和参考图完全一致，服装默认和参考图一致${look}），像用手机前置摄像头自拍一样近距离看着镜头，脸和上半身占据画面大部分，画面里看不到手机，正在给恋人录一段小视频。${speech}动作流畅，自然眨眼，头发和衣服随动作轻轻摆动。无字幕，无背景音乐，无文字。`;
  return `手机前置摄像头近距离拍的竖屏自拍视频，脸和肩膀占据画面大部分，镜头就是手机，画面里看不到手机，真实生活感。参考图里的成年女生（脸、发型、眼镜等配饰都和参考图完全一致${look}）看着镜头，正在给恋人录一段小视频。${speech}自然眨眼，头和肩膀轻轻晃动，有轻微的手持晃动。无字幕，无背景音乐，无文字。`;
}
function requestError(status, data) {
  const message = String(data?.error?.message || data?.message || '').slice(0, 200);
  if (status === 401 || status === 403) return new Error('视频 API Key 无效，请到连接设置检查');
  if (status === 402 || /余额|积分|insufficient/i.test(message)) return new Error('视频积分不足，请到 https://pixstag.com 充值');
  return new Error(`生成视频失败（HTTP ${status}）${message ? '：' + message : ''}`);
}
async function call(route, { apiKey, fetcher, signal, method = 'GET', body, timeout = 30000 }) {
  const res = await fetcher(BASE + route, { method, redirect: 'error', credentials: 'omit',
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(timeout)]),
    headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw requestError(res.status, data);
  return data?.data && typeof data.data === 'object' ? data.data : data;
}
export async function checkVideoKey(apiKey, { fetcher = fetch, signal } = {}) {
  if (!apiKey) throw new Error('请先在连接设置中填写视频 API Key');
  try { const user = await call('/user/me', { apiKey, fetcher, signal }); return { credit: user?.credit ?? null }; }
  catch (e) {
    if (signal?.aborted || e.message.startsWith('视频') || e.message.startsWith('生成视频')) throw e;
    throw new Error('无法连接视频服务，请检查网络后重试');
  }
}
function reference(type, role, bytes) {
  const key = type === 'image' ? 'image_url' : 'audio_url';
  return { type: key, [key]: { url: bytes.toString('base64') }, role };
}
async function submit(body, options) {
  // No idempotency key exists here, so a lost reply may already be a paid job: never resend it.
  try { return await call('/video_generation', { ...options, method: 'POST', body, timeout: 120000 }); }
  catch (e) {
    if (options.signal?.aborted || e.message.startsWith('视频') || e.message.startsWith('生成视频')) throw e;
    throw new Error('提交视频时网络中断，任务可能已创建，未重复提交');
  }
}
async function finish(taskId, options, { pollMs, now }) {
  const deadline = now() + MAX_WAIT_MS;
  for (let failures = 0; now() <= deadline;) {
    await delay(pollMs, undefined, { signal: options.signal });
    let task;
    // A failed status read says nothing about the job, so it must never cause a second submit.
    try { task = (await call(`/query/video_generation/${encodeURIComponent(taskId)}`, options)).task; failures = 0; }
    catch (e) { if (options.signal?.aborted || ++failures >= POLL_ERROR_LIMIT) throw e; continue; }
    if (task?.status === 'succeeded') return task;
    if (['failed', 'cancelled'].includes(task?.status)) throw new Error(`生成视频失败：${String(task.error?.message || task.status).slice(0, 200)}`);
  }
  throw new Error('生成视频超时，任务可能仍在进行，未重复提交');
}
export async function generateVideo({ apiKey, model = DEFAULT_VIDEO_MODEL, prompt, seconds, portrait, voiceSample }, { fetcher = fetch, signal, pollMs = 5000, now = Date.now } = {}) {
  const options = { apiKey, fetcher, signal };
  const content = [{ type: 'text', text: prompt }, reference('image', 'reference_image', portrait),
    ...(voiceSample ? [reference('audio', 'reference_audio', voiceSample)] : [])];
  const created = await submit({ model, duration: seconds, ratio: '3:4', resolution: '720P', content }, options);
  if (!created?.task_id) throw new Error('视频服务没有返回任务编号，未重复提交');
  const task = await finish(created.task_id, options, { pollMs, now });
  if (!task.content?.url?.startsWith('https://')) throw new Error('视频服务没有返回可下载的地址');
  // The download host is a storage bucket, so the API key must not travel there.
  const res = await fetcher(task.content.url, { redirect: 'follow', credentials: 'omit', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(120000)]) });
  if (!res.ok) throw new Error(`视频下载失败（HTTP ${res.status}）`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_VIDEO_BYTES) throw new Error('视频为空或超过 25 MB，未发送');
  return bytes;
}
