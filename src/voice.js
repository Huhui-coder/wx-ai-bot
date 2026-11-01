const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const PRESET_RESOURCE = 'seed-tts-2.0', CLONED_RESOURCE = 'seed-icl-2.0', DONE = 20000000;
export const DEFAULT_VOICE = 'zh_female_chunribu_uranus_bigtts';
export const VOICE_MAX_CHARS = 200;
const MAX_BYTES = 8 * 1024 * 1024;

// Voices cloned in the console are named S_xxx and are billed under a separate resource.
export const voiceResource = voice => /^S_/.test(voice) ? CLONED_RESOURCE : PRESET_RESOURCE;
export const voiceReady = config => Boolean(config.doubaoAppId && config.doubaoToken);
export const voiceDataURL = bytes => 'data:audio/mpeg;base64,' + bytes.toString('base64');

// The service answers with newline-separated JSON, each line holding a base64 audio chunk.
export function parseVoiceStream(body) {
  const chunks = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('豆包语音返回了无法解析的内容'); }
    if (event.code && event.code !== DONE) throw new Error(`豆包语音合成失败：${String(event.message || event.code).slice(0, 200)}`);
    if (event.data) chunks.push(Buffer.from(event.data, 'base64'));
  }
  const audio = Buffer.concat(chunks);
  if (!audio.length) throw new Error('豆包语音没有返回音频');
  if (audio.length > MAX_BYTES) throw new Error('语音过长，未发送');
  return audio;
}
export async function synthesize(text, config, { fetcher = fetch, signal } = {}) {
  if (!voiceReady(config)) throw new Error('请先在连接设置中填写豆包语音凭证');
  const content = typeof text === 'string' ? text.trim() : '';
  const speaker = config.doubaoVoice || DEFAULT_VOICE;
  if (!content || Array.from(content).length > VOICE_MAX_CHARS) throw new Error(`语音内容应为 1 到 ${VOICE_MAX_CHARS} 字`);
  let res;
  try {
    res = await fetcher(ENDPOINT, { method: 'POST', redirect: 'error', credentials: 'omit',
      signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(60000)]),
      headers: { 'Content-Type': 'application/json', 'X-Api-App-Id': config.doubaoAppId, 'X-Api-Access-Key': config.doubaoToken, 'X-Api-Resource-Id': voiceResource(speaker) },
      body: JSON.stringify({ user: { uid: 'weixin-lite' }, req_params: { text: content, speaker, audio_params: { format: 'mp3', sample_rate: 24000 } } }) });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error(e.name === 'TimeoutError' ? '豆包语音请求超时，请稍后重试' : '无法连接豆包语音服务，请检查网络');
  }
  if (res.status === 401 || res.status === 403) throw new Error('豆包语音凭证无效，请检查 App ID 和 Access Token');
  if (!res.ok) throw new Error(`豆包语音合成失败（HTTP ${res.status}）`);
  return parseVoiceStream(await res.text());
}
