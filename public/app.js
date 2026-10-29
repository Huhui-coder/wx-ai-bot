const $ = id => document.getElementById(id);
const auth = location.hash.slice(1) || sessionStorage.getItem('weixin-lite-token') || '';
if (location.hash) { sessionStorage.setItem('weixin-lite-token', auth); history.replaceState(null, '', location.pathname); }
let state, loaded = false, qrValue = '', messagesKey = '', toastTimer;
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
  for (const key of ['chat', 'settings', 'skills']) $('page-' + key).hidden = key !== name;
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  $('breadcrumb').textContent = '工作台 / ' + ({ chat: '对话', settings: '连接设置', skills: 'Skills' }[name]);
}
document.querySelectorAll('.nav').forEach(b => b.onclick = () => page(b.dataset.page));
document.querySelector('.brand').onclick = e => { e.preventDefault(); page('chat'); };
const statusNames = { connected: '已连接', stopped: '已暂停', unbound: '未绑定', expired: '需要重新扫码', reconnecting: '正在重连' };
const taskNames = { running: '运行中', done: '已完成', failed: '失败', cancelled: '已停止', timeout: '已超时' };
function renderMessages(messages) {
  const key = JSON.stringify(messages); if (key === messagesKey) return; messagesKey = key;
  const box = $('messages'); const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren();
  if (!messages.length) { const empty = el('div', 'empty-chat'); empty.append(el('div', 'intro', '你好，我在你的电脑上。'), el('p', '', '可以陪你聊天，也可以检查文件、执行命令，或按 Skill 的说明完成任务。\n先连接模型，再把我带进微信。')); box.append(empty); }
  for (const message of messages) {
    const row = el('div', 'message ' + message.role); const content = el('div');
    content.append(el('div', 'message-label', message.role === 'user' ? '你' : '助手'), el('div', 'message-body', message.text));
    row.append(el('div', 'avatar', message.role === 'user' ? '你' : '微'), content); box.append(row);
  }
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
async function refresh() {
  try {
    state = await api('state');
    if (!loaded) {
      for (const name of ['baseUrl', 'model', 'workspace', 'systemPrompt', 'imageDirectory']) $(name).value = state.config[name];
      $('allowMutations').checked = state.config.allowMutations;
      $('provider').value = state.config.baseUrl.includes('api.deepseek.com') ? 'deepseek' : 'custom';
      loaded = true;
    }
    $('setup-hint').hidden = state.config.hasApiKey;
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
    $('wechat-detail').textContent = state.wechat.lastError || (state.wechat.imageSaving ? '正在下载解密图片并保存到本机…' : '') || login?.error || (login ? loginNames[login.status] : '') || (state.wechat.bound ? '只有绑定的微信用户可以控制这台电脑。' : '绑定后，给 Bot 发消息即可调用当前模型。');
    $('verify-box').hidden = login?.status !== 'need_verifycode';
    if (login?.qr && login.qr !== qrValue) {
      const qr = await api('wechat/qr', {}); qrValue = login.qr;
      const image = el('img'); image.src = qr.image; image.alt = '使用微信扫描此二维码绑定助手'; $('qr-box').replaceChildren(image);
    }
    renderMessages(state.messages);
    $('approvals').replaceChildren(...state.approvals.map(a => {
      const card = el('div', 'approval'); card.append(el('h3', '', '允许这次操作？ · ' + a.name), el('pre', '', JSON.stringify(a.args, null, 2)));
      card.append(button('允许一次', async () => { await api('approve', { id: a.id, approved: true }); await refresh(); }, 'primary'), button('拒绝', async () => { await api('approve', { id: a.id, approved: false }); await refresh(); })); return card;
    }));
    $('tasks').replaceChildren(...(state.tasks.length ? state.tasks.slice(0, 8).map(t => {
      const card = el('div', 'task'), top = el('div', 'task-top'); top.append(el('span', 'task-command', t.command), el('span', 'task-status', `${t.id} · ${taskNames[t.status] || t.status}`));
      if (t.status === 'running') top.append(button('停止', async () => { await api('task/stop', { id: t.id }); await refresh(); }));
      card.append(top); if (t.output) { const details = el('details'); details.append(el('summary', 'subtle', '查看输出'), el('pre', '', t.output)); card.append(details); } return card;
    }) : [el('div', 'empty', '执行命令后，会在这里显示任务和结果。')]));
    $('skill-count').textContent = state.skills.length + ' 项';
    $('skill-list').replaceChildren(...(state.skills.length ? state.skills.map(s => { const card = el('div', 'skill-card'); card.append(el('h3', '', s.name), el('p', '', s.description || '已安装，可让助手读取此 Skill 的说明。')); return card; }) : [el('div', 'empty', '还没有安装 Skill。可以导入本地目录，也可以从 GitHub 安装。')]));
    $('data-dir').textContent = state.dataDir;
  } catch (e) { if (!loaded) toast(e.message); }
}
$('settings-form').onsubmit = async event => {
  event.preventDefault(); const data = {};
  for (const name of ['baseUrl', 'model', 'workspace', 'systemPrompt', 'imageDirectory']) data[name] = $(name).value;
  if ($('apiKey').value.trim()) data.apiKey = $('apiKey').value.trim();
  data.allowMutations = $('allowMutations').checked;
  try { const saved = await api('config', data); $('imageDirectory').value = saved.imageDirectory; $('apiKey').value = ''; toast('设置已保存'); await refresh(); } catch (e) { toast(e.message); }
};
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
