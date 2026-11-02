const $ = id => document.getElementById(id);
const auth = location.hash.slice(1) || sessionStorage.getItem('weixin-lite-token') || '';
if (location.hash) { sessionStorage.setItem('weixin-lite-token', auth); history.replaceState(null, '', location.pathname); }
let state, loaded = false, disconnected = false, qrValue = '', messagesKey = '', remindersKey = '', toastTimer, memoriesDirty = false, portraitSaved = false;
const PERSONA_FIELDS = { personaName: 'name', personaTitle: 'userTitle', personaPersonality: 'personality', personaCatchphrases: 'catchphrases', personaAppearance: 'appearance', personaStyle: 'style' };
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
async function api(route, data) {
  const response = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + auth, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
function button(text, action, className = 'quiet') { const b = el('button', className, text); b.type = 'button'; b.onclick = () => action().catch(e => toast(e.message)); return b; }
function page(name) {
  for (const key of ['chat', 'persona', 'settings', 'skills', 'reminders']) $('page-' + key).hidden = key !== name;
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  $('breadcrumb').textContent = '工作台 / ' + ({ chat: '对话', persona: '人格', settings: '连接设置', skills: 'Skills', reminders: '提醒' }[name]);
}
document.querySelectorAll('.nav').forEach(b => b.onclick = () => page(b.dataset.page));
document.querySelector('.brand').onclick = e => { e.preventDefault(); page('chat'); };
const statusNames = { connected: '已连接', stopped: '已暂停', unbound: '未绑定', expired: '需要重新扫码', reconnecting: '正在重连' };
const taskNames = { running: '运行中', done: '已完成', failed: '失败', cancelled: '已停止', timeout: '已超时' };
function renderMessages(messages) {
  const key = JSON.stringify(messages); if (key === messagesKey) return; messagesKey = key;
  const box = $('messages'); const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren();
  if (!messages.length) { const empty = el('div', 'empty-chat'); empty.append(el('div', 'intro', '你来啦。'), el('p', '', '可以陪你聊天，也可以帮你看文件、跑命令。\n先连接模型，再把我带进微信。')); box.append(empty); }
  for (const message of messages) {
    const row = el('div', 'message ' + message.role); const content = el('div');
    const name = state?.persona.enabled ? state.persona.name : '助手';
    content.append(el('div', 'message-label', message.role === 'user' ? '你' : name), el('div', 'message-body', message.text));
    row.append(el('div', 'avatar', message.role === 'user' ? '你' : Array.from(state?.persona.enabled ? name : '微')[0]), content); box.append(row);
  }
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
function renderReminders(data) {
  $('reminder-clock').textContent = '当前时间：' + data.currentTime;
  const key = JSON.stringify(data.reminders); if (key === remindersKey) return; remindersKey = key;
  const names = { scheduled: '待提醒', queued: '待发送', sent: '已发送', cancelled: '已取消', blocked: '绑定已改变' };
  const taskNames = { scheduled: '待执行', queued: '开始执行', sent: '已开始执行' };
  const pending = data.reminders.filter(r => ['scheduled', 'queued'].includes(r.status)).length;
  $('reminder-count').textContent = pending + ' 条待提醒';
  $('reminder-list').replaceChildren(...(data.reminders.length ? data.reminders.map(r => {
    const card = el('div', 'task'), top = el('div', 'task-top');
    const task = r.kind === 'task';
    top.append(el('strong', '', r.text), el('span', 'task-status', (task && taskNames[r.status]) || names[r.status] || r.status)); card.append(top);
    if (task) card.append(el('p', 'subtle', `定时任务 · 可自动执行：${r.grants.commands.join('、') || '无'}${r.grants.writes ? ' · 可写文件' : ''}${r.quiet ? ' · 无事不通知' : ''}`));
    if (r.repeat) card.append(el('p', 'subtle', r.repeatLabel));
    const nextLabel = r.repeat ? (['scheduled', 'queued'].includes(r.status) ? '下一次：' : '原计划：') : '';
    card.append(el('p', 'subtle', nextLabel + r.localTime), el('p', 'subtle', '编号：' + r.id));
    if (r.lastSentAt) card.append(el('p', 'subtle', `已${task ? '执行' : '发送'} ${r.deliveryCount} 次`));
    if (r.lastError) card.append(el('p', 'subtle', r.lastError));
    if (['scheduled', 'queued', 'blocked'].includes(r.status)) card.append(button(r.repeat ? `取消整组重复${task ? '任务' : '提醒'}` : `取消${task ? '任务' : '提醒'}`, async () => { await api('reminders/cancel', { id: r.id }); toast('已取消'); await refresh(); }));
    return card;
  }) : [el('div', 'empty', '还没有提醒。可以在微信里说：“10 分钟后提醒我总结日报。”')]));
}
const CONFIG_FIELDS = ['baseUrl', 'model', 'workspace', 'systemPrompt', 'imageDirectory', 'doubaoAppId', 'doubaoVoice', 'videoModel'];
function showPortrait(image, alt) { const node = el('img'); node.src = image; node.alt = alt; $('portrait-box').replaceChildren(node); }
async function loadPortrait() {
  const { image } = await api('persona/portrait'); portraitSaved = Boolean(image);
  $('portrait-state').textContent = portraitSaved ? '已设置' : '未设置';
  if (image) showPortrait(image, '她的形象照');
}
function personaData() {
  const data = { enabled: $('personaEnabled').checked, memories: $('personaMemories').value.split('\n') };
  for (const [id, name] of Object.entries(PERSONA_FIELDS)) data[name] = $(id).value;
  return data;
}
async function savePersona() { await api('persona', personaData()); memoriesDirty = false; }
async function refresh() {
  try {
    state = await api('state');
    if (!loaded) {
      for (const name of CONFIG_FIELDS) $(name).value = state.config[name];
      for (const [id, name] of Object.entries(PERSONA_FIELDS)) $(id).value = state.persona[name];
      $('personaEnabled').checked = state.persona.enabled;
      await loadPortrait();
      for (const name of ['allowMutations', 'vision', 'keepAwake']) $(name).checked = state.config[name];
      $('allowedCommands').value = state.config.allowedCommands.join('\n');
      $('maxCommandMinutes').value = state.config.maxCommandMinutes;
      $('provider').value = state.config.baseUrl.includes('api.deepseek.com') ? 'deepseek' : 'custom';
      loaded = true;
    }
    disconnected = false;
    if (!memoriesDirty) $('personaMemories').value = state.persona.memories.join('\n');
    $('doubao-state').textContent = state.config.hasDoubaoToken ? '· 已保存' : '';
    $('image-state').textContent = state.config.hasImageKey ? '· 已保存' : '';
    $('video-state').textContent = state.config.hasVideoKey ? '· 已保存' : '';
    $('autostart-row').hidden = !state.autostart.supported; $('autostart').checked = state.autostart.enabled;
    $('setup-hint').hidden = state.config.hasApiKey;
    $('persona-hint').hidden = !state.config.hasApiKey || state.persona.enabled;
    $('key-state').textContent = state.config.hasApiKey ? '· 已保存' : '';
    $('model-label').textContent = state.config.model;
    $('send').disabled = state.busy; $('stop').hidden = !state.busy && !state.tasks.some(t => t.status === 'running');
    $('busy-label').textContent = state.busy ? (state.approvals.length ? '等待你的允许' : '助手正在处理…') : '准备就绪';
    $('aside-status').textContent = state.wechat.bound ? '微信 ' + statusNames[state.wechat.status] : '微信尚未绑定';
    $('connection-dot').classList.toggle('connected', state.wechat.status === 'connected');
    $('wechat-status').textContent = statusNames[state.wechat.status] || state.wechat.status;
    $('wechat-toggle').hidden = !state.wechat.bound;
    $('wechat-toggle').textContent = state.wechat.status === 'stopped' ? '恢复连接' : '暂停连接';
    $('retry-replies').hidden = !state.wechat.pendingReplies;
    $('retry-replies').textContent = '重试未送达的回复（' + state.wechat.pendingReplies + '）';
    const login = state.wechat.login;
    const loginNames = { wait: '等待扫码…', scaned: '已扫码，请在手机确认', confirmed: '微信已绑定', expired: '二维码已过期，请重新生成', need_verifycode: '请输入微信显示的验证码', verify_code_blocked: '验证码尝试过多，请重新生成二维码', error: '扫码失败', binded_redirect: '已绑定' };
    $('wechat-detail').textContent = state.wechat.lastError || (state.wechat.imageSaving ? '正在下载解密图片或附件并保存到本机…' : '') || login?.error || (login ? loginNames[login.status] : '') || (state.wechat.bound ? '只有绑定的微信用户可以控制这台电脑。' : '绑定后，给 Bot 发消息即可调用当前模型。');
    $('verify-box').hidden = login?.status !== 'need_verifycode';
    if (login?.qr && login.qr !== qrValue) {
      const qr = await api('wechat/qr', {}); qrValue = login.qr;
      const image = el('img'); image.src = qr.image; image.alt = '使用微信扫描此二维码绑定助手'; $('qr-box').replaceChildren(image);
    }
    renderMessages(state.messages);
    renderReminders(state.reminders);
    $('approvals').replaceChildren(...state.approvals.map(a => {
      const card = el('div', 'approval'); card.append(el('h3', '', '允许这次操作？ · ' + a.name), el('pre', '', a.summary));
      card.append(button('允许一次', async () => { await api('approve', { id: a.id, approved: true }); await refresh(); }, 'primary'));
      if (a.scope) card.append(button('本次对话都允许：' + a.scope, async () => { await api('approve', { id: a.id, approved: true, always: true }); await refresh(); }));
      card.append(button('拒绝', async () => { await api('approve', { id: a.id, approved: false }); await refresh(); })); return card;
    }));
    $('tasks').replaceChildren(...(state.tasks.length ? state.tasks.slice(0, 8).map(t => {
      const card = el('div', 'task'), top = el('div', 'task-top'); top.append(el('span', 'task-command', t.command), el('span', 'task-status', `${t.id} · ${taskNames[t.status] || t.status}`));
      if (t.status === 'running') top.append(button('停止', async () => { await api('task/stop', { id: t.id }); await refresh(); }));
      card.append(top); if (t.output) { const details = el('details'); details.append(el('summary', 'subtle', '查看输出'), el('pre', '', t.output)); card.append(details); } return card;
    }) : [el('div', 'empty', '执行命令后，会在这里显示任务和结果。')]));
    $('skill-count').textContent = state.skills.length + ' 项';
    $('skill-list').replaceChildren(...(state.skills.length ? state.skills.map(s => { const card = el('div', 'skill-card'); card.append(el('h3', '', s.name), el('p', '', s.description || '已安装，可让助手读取此 Skill 的说明。')); return card; }) : [el('div', 'empty', '还没有安装 Skill。可以导入本地目录，也可以从 GitHub 安装。')]));
    $('data-dir').textContent = state.dataDir;
  } catch (e) {
    if (!loaded) toast(e.message);
    else if (!disconnected) { disconnected = true; $('aside-status').textContent = '与本机服务的连接已断开，正在重试…'; $('connection-dot').classList.remove('connected'); }
  }
}
$('settings-form').onsubmit = async event => {
  event.preventDefault(); const data = {};
  for (const name of CONFIG_FIELDS) data[name] = $(name).value;
  for (const name of ['apiKey', 'doubaoToken', 'imageApiKey', 'videoApiKey']) if ($(name).value.trim()) data[name] = $(name).value.trim();
  for (const name of ['allowMutations', 'vision', 'keepAwake']) data[name] = $(name).checked;
  data.allowedCommands = $('allowedCommands').value.split('\n');
  data.maxCommandMinutes = Number($('maxCommandMinutes').value);
  try { const saved = await api('config', data); $('imageDirectory').value = saved.imageDirectory; $('doubaoVoice').value = saved.doubaoVoice; for (const name of ['apiKey', 'doubaoToken', 'imageApiKey', 'videoApiKey']) $(name).value = ''; toast('设置已保存'); await refresh(); if (state.keepAwake.error) toast(state.keepAwake.error); } catch (e) { toast(e.message); }
};
$('personaMemories').oninput = () => { memoriesDirty = true; };
$('persona-form').onsubmit = async event => {
  event.preventDefault(); const enabling = $('personaEnabled').checked && !state.persona.enabled;
  try { await savePersona(); toast(enabling ? '人格已启用。建议在对话页点“新对话”，换掉旧聊天的语气' : '人格已保存'); await refresh(); } catch (e) { toast(e.message); }
};
$('portrait-draft').onclick = async () => {
  const b = $('portrait-draft'); b.disabled = true;
  try {
    await savePersona(); toast('正在生成形象照，大约需要一到两分钟…');
    const { image } = await api('persona/portrait/draft', {}); showPortrait(image, '形象照候选'); $('portrait-accept').hidden = false; toast('生成好了。满意就点“就用这张”，不满意可以再生成一张');
  } catch (e) { toast(e.message); } finally { b.disabled = false; }
};
// Compressed here because the browser can decode every photo, and the video upload is slow.
async function compressPhoto(file) {
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('这张图片打不开，请换一张 JPG 或 PNG'); });
  for (const [side, quality] of [[1024, 0.85], [1024, 0.7], [800, 0.7], [640, 0.65]]) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/jpeg', quality);
    if (image.length * 0.75 <= 450000) return image;
  }
  throw new Error('图片太复杂，压缩后仍然过大，请换一张');
}
$('portrait-upload').onclick = () => $('portrait-file').click();
$('portrait-file').onchange = async () => {
  const file = $('portrait-file').files[0], b = $('portrait-upload'); if (!file) return;
  b.disabled = true;
  try { await api('persona/portrait/upload', { image: await compressPhoto(file) }); $('portrait-accept').hidden = true; await loadPortrait(); toast('形象照已设置'); }
  catch (e) { toast(e.message); } finally { b.disabled = false; $('portrait-file').value = ''; }
};
$('portrait-accept').onclick = async () => { try { await api('persona/portrait/accept', {}); $('portrait-accept').hidden = true; await loadPortrait(); toast('形象照已设置'); } catch (e) { toast(e.message); } };
$('test-voice').onclick = async () => {
  const b = $('test-voice'); b.disabled = true;
  try { toast('正在合成语音…'); const { audio } = await api('voice/test', {}); const player = $('voice-preview'); player.src = audio; player.hidden = false; await player.play().catch(() => {}); } catch (e) { toast(e.message); } finally { b.disabled = false; }
};
$('test-video').onclick = async () => {
  const b = $('test-video'); b.disabled = true;
  try { const r = await api('video/check', {}); toast(`Key 可用 · 剩余积分 ${r.credit ?? '未知'}`); } catch (e) { toast(e.message); } finally { b.disabled = false; }
};
$('test-image').onclick = async () => {
  const b = $('test-image'); b.disabled = true;
  try { const r = await api('image/check', {}); toast(`Key 可用 · ${r.group}${r.balance == null ? '' : ` · 余额 ${r.balance} ${r.unit}`}`); } catch (e) { toast(e.message); } finally { b.disabled = false; }
};
$('autostart').onchange = async () => { try { const result = await api('autostart', { enabled: $('autostart').checked }); toast(result.warning || (result.enabled ? '已开启自动启动' : '已关闭自动启动')); await refresh(); } catch (e) { toast(e.message); await refresh(); } };
$('provider').onchange = () => { if ($('provider').value === 'deepseek') { $('baseUrl').value = 'https://api.deepseek.com'; $('model').value = 'deepseek-flash'; } };
$('test-model').onclick = async () => { $('test-model').disabled = true; try { toast('正在测试已保存的模型配置…'); const r = await api('model/test', {}); toast(r.text); } catch (e) { toast(e.message); } finally { $('test-model').disabled = false; } };
$('chat-form').onsubmit = async event => {
  event.preventDefault(); const text = $('chat-input').value.trim(); if (!text) return;
  try { await api('chat', { text }); $('chat-input').value = ''; await refresh(); } catch (e) { toast(e.message); }
};
$('chat-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state?.busy) $('chat-form').requestSubmit(); } };
$('stop').onclick = async () => { try { await api('stop', {}); toast('已停止'); await refresh(); } catch (e) { toast(e.message); } };
$('new-chat').onclick = async () => { try { await api('new', {}); await refresh(); } catch (e) { toast(e.message); } };
$('wechat-login').onclick = async () => { $('wechat-login').disabled = true; try { toast('正在生成微信二维码…'); await api('wechat/login', {}); await refresh(); } catch (e) { toast(e.message); } finally { $('wechat-login').disabled = false; } };
$('wechat-toggle').onclick = async () => { try { await api('wechat/' + (state.wechat.status === 'stopped' ? 'start' : 'stop'), {}); await refresh(); } catch (e) { toast(e.message); } };
$('verify-button').onclick = async () => { try { await api('wechat/verify', { code: $('verify-code').value }); $('verify-code').value = ''; await refresh(); } catch (e) { toast(e.message); } };
$('retry-replies').onclick = async () => { try { await api('wechat/retry', {}); toast('已重试发送'); await refresh(); } catch (e) { toast(e.message); } };
$('skill-form').onsubmit = async event => {
  event.preventDefault(); const b = event.submitter; b.disabled = true;
  try { await api('skills/install', { name: $('skill-name').value, source: $('skill-source').value, subdir: $('skill-subdir').value }); toast('Skill 已安装，可以直接让助手使用'); $('skill-form').reset(); await refresh(); } catch (e) { toast(e.message); } finally { b.disabled = false; }
};
await refresh();
setInterval(refresh, 1500);
