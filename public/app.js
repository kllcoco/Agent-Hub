/* Agent Hub dashboard — rooms, live feed, roster, switches, human composer. */

const $ = (selector) => document.querySelector(selector);

const TOKEN = new URLSearchParams(location.search).get('token') ?? localStorage.getItem('hub.token') ?? '';
if (TOKEN) localStorage.setItem('hub.token', TOKEN);

/** Empty = same origin. The desktop single-file build sets window.__AGENT_HUB_URL__. */
const API_BASE = (() => {
  const configured = typeof window.__AGENT_HUB_URL__ === 'string' ? window.__AGENT_HUB_URL__ : '';
  const base = configured.length > 0 ? configured : (location.protocol === 'file:' ? 'http://127.0.0.1:8787' : '');
  return base.replace(/\/+$/u, '');
})();
const HUB_ORIGIN = API_BASE.length > 0 ? API_BASE : location.origin;

const KIND_LABEL = { message: '', task: 'task', decision: 'decision', note: 'note', system: 'system' };
const SWITCH_META = {
  claude: { name: 'Claude', note: 'Claude Code / Desktop' },
  codex: { name: 'GPT / Codex', note: 'Codex CLI' },
  dsh: { name: 'DSH（我）', note: '当前会话 / 自动回复' },
};
const HIDDEN_AGENTS = new Set(['worker', 'checker', 'cli-agent', 'e2e-mcp', 'e2e-cli']);

const state = {
  rooms: [],
  agents: new Map(),
  switches: null,
  fastReplies: true,
  broadcastMode: 'all',
  typing: new Map(),
  tasks: [],
  attachments: [],
  replyTo: null,
  workspaceRoot: '',
  wsPath: '',
  wsEntries: [],
  wsFile: null,
  reviewTaskId: null,
  messages: [],
  seenIds: new Set(),
  currentRoom: localStorage.getItem('hub.room') ?? 'general',
  filterAgent: null,
  query: '',
  cursor: 0,
  stream: null,
  connected: false,
  readCounts: JSON.parse(localStorage.getItem('hub.readCounts') ?? '{}'),
  pendingNew: 0,
  loading: true,
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (TOKEN) headers['x-hub-token'] = TOKEN;
  if (options.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  return fetch(`${API_BASE}${path}`, { ...options, headers }).then(async (response) => {
    const text = await response.text();
    const value = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Small, safe markdown: fenced code, inline code, bold, links, @mentions. */
function renderMarkdown(input) {
  let text = escapeHtml(input);
  const tokens = [];
  const stash = (html) => {
    const index = tokens.push(html) - 1;
    return `\u0000T${index}\u0000`;
  };
  text = text.replace(/```[\w-]*\r?\n([\s\S]*?)```/gu, (_m, code) => stash(`<pre><code>${code.replace(/\n$/u, '')}</code></pre>`));
  text = text.replace(/`([^`\n]+)`/gu, (_m, code) => stash(`<code>${code}</code>`));
  text = text.replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>');
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  text = text.replace(/@([a-zA-Z0-9][a-zA-Z0-9._-]{0,39})/gu, '<span class="mention">@$1</span>');
  text = text.replace(/\r?\n/gu, '<br />');
  return text.replace(/\u0000T(\d+)\u0000/gu, (_m, index) => tokens[Number(index)] ?? '');
}

function initials(name) {
  const clean = String(name).replace(/[^a-zA-Z0-9]/gu, '');
  return (clean.slice(0, 2) || 'AI').toUpperCase();
}

function mentionsModel(text) {
  return /(^|[^a-z0-9])@?(claude|codex|gpt|chatgpt|openai|dsh|deepseek)([^a-z0-9]|$)/iu.test(String(text));
}

/** Native brand marks for the models; fall back to initials for unknown agents. */
function logoKey(agent) {
  const name = String(agent).toLowerCase();
  if (name.includes('claude') || name.includes('anthropic')) return 'claude';
  if (name.includes('codex') || name.includes('gpt') || name.includes('chatgpt') || name.includes('openai')) return 'openai';
  if (name.includes('dsh') || name.includes('deepseek')) return 'deepseek';
  if (name.includes('worker')) return 'worker';
  if (name.includes('human')) return 'human';
  return null;
}

function logoUrl(key) {
  return window.__AGENT_HUB_LOGOS__?.[key] ?? `/logos/${key}.svg`;
}

function avatarHtml(agent, color, extraStyle = '') {
  const key = logoKey(agent);
  const style = `--c:${escapeHtml(color ?? '#8b9bb4')}${extraStyle ? `;${extraStyle}` : ''}`;
  if (key !== null) {
    return `<span class="avatar logo-avatar" style="${style}"><img src="${logoUrl(key)}" alt="" loading="lazy" /></span>`;
  }
  return `<span class="avatar" style="${style}">${escapeHtml(initials(agent))}</span>`;
}

function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dayLabel(iso) {
  const date = new Date(iso);
  if (date.toDateString() === new Date().toDateString()) return '今天';
  return date.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2400);
}

/* ------------------------------------------------------------------ */
/* rooms                                                               */
/* ------------------------------------------------------------------ */

function unreadFor(room) {
  const read = state.readCounts[room.id] ?? room.messageCount;
  return Math.max(0, room.messageCount - read);
}

function markRoomRead(roomId, count) {
  if (Number.isFinite(count)) state.readCounts[roomId] = count;
  localStorage.setItem('hub.readCounts', JSON.stringify(state.readCounts));
}

function updateRoomActions() {
  const current = state.rooms.find((room) => room.id === state.currentRoom);
  const pin = $('#pinRoomBtn');
  pin.hidden = current === undefined;
  pin.setAttribute('aria-pressed', String(current?.pinned === true));
  pin.title = current?.pinned ? '取消置顶当前房间' : '置顶当前房间';
  const remove = $('#deleteRoomBtn');
  remove.hidden = current === undefined;
  remove.classList.remove('disabled');
  remove.title = '删除当前房间';
  $('#roomManageBtn').hidden = current === undefined;
}

async function togglePin(room) {
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(room.id)}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned: room.pinned !== true }),
    });
    state.rooms = data.rooms ?? state.rooms;
    renderRooms();
    toast(room.pinned === true ? `已取消置顶 #${room.name}` : `已置顶 #${room.name}`);
  } catch (error) {
    toast(`置顶失败：${error.message}`);
  }
}

function renderPinnedBanner() {
  const banner = $('#pinnedBanner');
  if (banner === null) return;
  const room = state.rooms.find((entry) => entry.id === state.currentRoom);
  const pinned = room?.pinnedMessage;
  if (pinned === null || pinned === undefined) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  $('#pinnedWho').textContent = pinned.agent;
  $('#pinnedText').textContent = String(pinned.text).replace(/\s+/gu, ' ').slice(0, 220);
}

async function toggleMessagePin(message) {
  const room = state.rooms.find((entry) => entry.id === state.currentRoom);
  if (room === undefined) return;
  const wasPinned = room.pinnedMessage?.id === message.id;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(room.id)}/pin-message`, {
      method: 'POST',
      body: JSON.stringify({ messageId: message.id }),
    });
    state.rooms = data.rooms ?? state.rooms;
    renderRooms();
    renderMessages();
    toast(wasPinned ? '已取消置顶消息' : '已置顶消息');
  } catch (error) {
    toast(`置顶消息失败：${error.message}`);
  }
}

function renderRooms() {
  const container = $('#rooms');
  container.replaceChildren();
  const rooms = [...state.rooms].sort((left, right) => Number(right.pinned === true) - Number(left.pinned === true));
  for (const room of rooms) {
    const item = document.createElement('div');
    item.className = `room-item${room.id === state.currentRoom ? ' active' : ''}`;
    item.title = room.topic || room.name;
    const unread = unreadFor(room);
    item.innerHTML = `
      <span class="hash">#</span>
      <span class="room-name">${escapeHtml(room.name)}</span>
      ${unread > 0 ? `<span class="unread">${unread > 99 ? '99+' : unread}</span>` : `<span class="room-count">${room.messageCount}</span>`}
    `;
    item.addEventListener('click', () => {
      selectRoom(room.id);
      closeSidebar();
    });
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = `room-pin${room.pinned === true ? ' pinned' : ''}`;
    pin.title = room.pinned === true ? `取消置顶 #${room.name}` : `置顶 #${room.name}`;
    pin.setAttribute('aria-label', pin.title);
    pin.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3h6l-1 5 3 3v2h-4v4l-1 1-1-1v-4H5v-2l3-3z"/></svg>';
    pin.addEventListener('click', (event) => {
      event.stopPropagation();
      togglePin(room);
    });
    item.append(pin);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'room-delete';
    remove.title = `删除房间 #${room.name}`;
    remove.setAttribute('aria-label', remove.title);
    remove.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M8 5V3h4v2M6 5l1 11h6l1-11"/></svg>';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      const ok = await askConfirm('删除房间', deleteRoomMessage(room), '删除');
      if (ok) await deleteRoom(room);
    });
    item.append(remove);
    container.append(item);
  }
  updateRoomActions();
  renderPinnedBanner();
}

function deleteRoomMessage(room) {
  const note = room.id === 'general' && state.rooms.length <= 1 ? '\n这是唯一的房间；删除后会自动重建一个空的 general。' : '';
  return `确定删除 #${room.name} 及其全部消息？此操作不可恢复。${note}`;
}

async function loadRooms() {
  const { rooms } = await api('/api/rooms');
  state.rooms = rooms;
  for (const room of rooms) {
    if (room.id === state.currentRoom) markRoomRead(room.id, room.messageCount);
  }
  renderRooms();
  updateDocumentTitle();
}

let confirmResolve = null;
function askConfirm(title, text, okLabel = '确认') {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
  $('#confirmDialog').showModal();
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function settleConfirm(value) {
  if (confirmResolve !== null) {
    confirmResolve(value);
    confirmResolve = null;
  }
  $('#confirmDialog').close();
}

async function deleteRoom(room) {
  try {
    await api(`/api/rooms/${encodeURIComponent(room.id)}`, { method: 'DELETE' });
    const wasCurrent = state.currentRoom === room.id;
    await loadRooms();
    if (wasCurrent) await selectRoom(state.rooms[0]?.id ?? 'general');
    toast(`已删除 #${room.name}`);
  } catch (error) {
    toast(`删除失败：${error.message}`);
  }
}

function openRoomManage() {
  const room = state.rooms.find((entry) => entry.id === state.currentRoom);
  if (room === undefined) return;
  $('#roomManageTitle').textContent = `房间管理 · #${room.name}`;
  $('#roomManageMeta').textContent = `${room.topic || '共享工作空间'} · ${room.messageCount} 条消息`;
  $('#managePin').textContent = room.pinned ? '取消置顶房间' : '置顶房间';
  $('#roomManageDialog').showModal();
}

async function selectRoom(roomId) {
  state.currentRoom = roomId;
  localStorage.setItem('hub.room', roomId);
  markRoomRead(roomId);
  state.messages = [];
  state.seenIds.clear();
  state.cursor = 0;
  state.filterAgent = null;
  state.query = '';
  state.pendingNew = 0;
  state.typing.clear();
  renderTyping();
  clearReply();
  $('#searchInput').value = '';
  $('#searchResult').textContent = '';
  const room = state.rooms.find((entry) => entry.id === roomId);
  const displayName = room?.name ?? roomId;
  $('#roomName').textContent = displayName;
  $('#roomTopic').textContent = room?.topic || '共享工作空间';
  $('#crumbRoom').textContent = displayName;
  updateDocumentTitle();
  await loadMessages({ tail: true });
  connectStream();
  updateJump();
  $('#text').focus();
}

/* ------------------------------------------------------------------ */
/* agents & switches                                                   */
/* ------------------------------------------------------------------ */

function upsertAgent(agent) {
  const existing = state.agents.get(agent.agent) ?? { color: agent.color, role: agent.role, count: 0 };
  state.agents.set(agent.agent, {
    agent: agent.agent,
    role: agent.role ?? existing.role ?? '',
    color: agent.color ?? existing.color,
    online: agent.online !== false,
    lastSeen: agent.lastSeen ?? existing.lastSeen,
    count: existing.count,
  });
}

function renderAgents() {
  const container = $('#agents');
  container.replaceChildren();
  const agents = [...state.agents.values()]
    .filter((agent) => agent.agent !== 'human' && !HIDDEN_AGENTS.has(agent.agent))
    .sort((left, right) => Number(right.online) - Number(left.online) || left.agent.localeCompare(right.agent));
  if (agents.length === 0) {
    container.innerHTML = '<p class="muted" style="padding:2px 8px;font-size:12px">还没有 agent 加入</p>';
  }
  for (const agent of agents) {
    const item = document.createElement('div');
    item.className = `agent-item${state.filterAgent === agent.agent ? ' active' : ''}`;
    item.title = `${agent.agent}${agent.role ? ` · ${agent.role}` : ''}`;
    item.innerHTML = `
      ${avatarHtml(agent.agent, agent.color)}
      <span class="agent-meta">
        <span class="agent-name">${escapeHtml(agent.agent)}</span>
        <span class="agent-role">${escapeHtml(agent.role || (agent.online ? '在线' : '离线'))}</span>
      </span>
      ${agent.count > 0 ? `<span class="agent-count">${agent.count}</span>` : ''}
      <span class="status-dot${agent.online ? ' online' : ''}"></span>
    `;
    item.addEventListener('click', () => toggleAgentFilter(agent.agent));
    container.append(item);
  }
  $('#agentCount').textContent = String(agents.filter((agent) => agent.online).length);
  syncComposerOptions();
}

function toggleAgentFilter(agent) {
  state.filterAgent = state.filterAgent === agent ? null : agent;
  renderAgents();
  renderFilterChips();
  renderMessages();
}

function renderSwitches() {
  const container = $('#switches');
  container.replaceChildren();
  if (state.switches === null) {
    container.innerHTML = '<p class="muted" style="padding:2px 8px;font-size:12px">加载中…</p>';
    return;
  }
  for (const key of ['claude', 'codex', 'dsh']) {
    const meta = SWITCH_META[key];
    const on = state.switches[key] === true;
    const block = document.createElement('div');
    block.className = 'model-block';
    block.dataset.on = String(on);
    block.title = `${meta.name}：调用${on ? '开启' : '关闭'}（使用本机 harness 的默认模型）`;

    const row = document.createElement('div');
    row.className = 'switch-row';
    const brandColors = { claude: '#D97757', codex: '#10A37F', dsh: '#4D6BFE' };
    const logo = document.createElement('span');
    logo.className = 'switch-logo';
    logo.style.setProperty('--c', brandColors[key] ?? '#8b9bb4');
    logo.innerHTML = `<img src="${logoUrl(logoKey(key) ?? key)}" alt="" />`;
    const label = document.createElement('span');
    label.className = 'switch-label';
    label.innerHTML = `<span class="switch-name">${escapeHtml(meta.name)}</span><span class="switch-note">${escapeHtml(meta.note)} · ${on ? '调用开启' : '调用关闭'}</span>`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `switch${on ? ' on' : ''}`;
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(on));
    button.innerHTML = '<span></span>';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleSwitch(key, !on);
    });
    row.append(logo, label, button);
    block.append(row);
    container.append(block);
  }
}

function renderTyping() {
  const bar = $('#typingBar');
  const agents = [...state.typing.keys()];
  if (agents.length === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const starts = [...state.typing.values()].map((entry) => entry.startedAt ?? Date.now());
  const seconds = Math.max(0, Math.round((Date.now() - Math.min(...starts)) / 1000));
  $('#typingText').textContent = `${agents.join('、')} 正在回复… ${seconds}s`;
}

function markTyping(agent, typing) {
  const existing = state.typing.get(agent);
  if (existing?.timer) clearTimeout(existing.timer);
  if (typing === true) {
    const startedAt = existing?.startedAt ?? Date.now();
    const timer = setTimeout(() => {
      state.typing.delete(agent);
      renderTyping();
    }, 45_000);
    state.typing.set(agent, { timer, startedAt });
  } else {
    state.typing.delete(agent);
  }
  renderTyping();
}

async function toggleSwitch(agent, enabled) {
  const label = SWITCH_META[agent]?.name ?? agent;
  try {
    const data = await api('/api/switches', { method: 'POST', body: JSON.stringify({ agent, enabled }) });
    state.switches = data.switches;
    renderSwitches();
    toast(`${label}：调用已${enabled ? '开启' : '关闭'}`);
  } catch (error) {
    toast(`切换失败：${error.message}`);
  }
}

function syncComposerOptions() {
  const sendAs = $('#sendAs');
  const previous = sendAs.value || 'human';
  const names = ['human', ...[...state.agents.keys()].filter((name) => name !== 'human' && !HIDDEN_AGENTS.has(name))];
  sendAs.replaceChildren(...names.map((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name === 'human' ? 'human（你）' : name;
    return option;
  }));
  sendAs.value = names.includes(previous) ? previous : 'human';

  const to = $('#to');
  const previousTo = to.value;
  to.replaceChildren(new Option('所有人', ''));
  for (const name of names) {
    if (name === 'human') continue;
    to.append(new Option(`@${name}`, name));
  }
  to.value = [...to.options].some((option) => option.value === previousTo) ? previousTo : '';
}

/* ------------------------------------------------------------------ */
/* messages                                                            */
/* ------------------------------------------------------------------ */

async function loadMessages({ tail = false } = {}) {
  state.loading = true;
  const params = new URLSearchParams({ limit: '150' });
  if (!tail && state.cursor > 0) params.set('since', String(state.cursor));
  const data = await api(`/api/rooms/${encodeURIComponent(state.currentRoom)}/messages?${params}`);
  state.cursor = Math.max(state.cursor, data.cursor ?? 0);
  for (const message of data.messages) {
    if (HIDDEN_AGENTS.has(message.agent)) continue;
    if (state.seenIds.has(message.id)) continue;
    state.seenIds.add(message.id);
    state.messages.push(message);
  }
  if (tail) {
    state.messages.sort((left, right) => left.seq - right.seq);
    state.cursor = data.cursor ?? 0;
  }
  state.loading = false;
  markRoomRead(state.currentRoom, data.room?.messageCount ?? state.cursor);
  renderAll();
  scrollToBottom(false);
}

function participants() {
  const map = new Map();
  for (const message of state.messages) {
    if (HIDDEN_AGENTS.has(message.agent)) continue;
    const entry = map.get(message.agent) ?? {
      agent: message.agent,
      color: message.color ?? state.agents.get(message.agent)?.color ?? '#8b9bb4',
      role: message.role ?? state.agents.get(message.agent)?.role ?? '',
      count: 0,
    };
    entry.count += 1;
    if (message.role) entry.role = message.role;
    map.set(message.agent, entry);
  }
  return [...map.values()].sort((left, right) => right.count - left.count);
}

function renderFilterChips() {
  const bar = $('#filterBar');
  const container = $('#filterChips');
  const query = state.query.trim();
  const active = state.filterAgent !== null || query.length > 0;
  if (!active) {
    bar.hidden = true;
    container.replaceChildren();
    return;
  }
  bar.hidden = false;
  container.replaceChildren();
  const list = participants();
  const all = document.createElement('button');
  all.className = `chip${state.filterAgent === null ? ' active' : ''}`;
  all.textContent = `全部 · ${state.messages.length}`;
  all.addEventListener('click', () => {
    state.filterAgent = null;
    renderAgents();
    renderFilterChips();
    renderMessages();
  });
  container.append(all);
  for (const participant of list) {
    const chip = document.createElement('button');
    chip.className = `chip${state.filterAgent === participant.agent ? ' active' : ''}`;
    chip.innerHTML = `<span class="dot" style="background:${escapeHtml(participant.color)}"></span>${escapeHtml(participant.agent)} <span class="muted">${participant.count}</span>`;
    chip.addEventListener('click', () => {
      state.filterAgent = state.filterAgent === participant.agent ? null : participant.agent;
      renderAgents();
      renderFilterChips();
      renderMessages();
    });
    container.append(chip);
  }
  $('#clearFilter').hidden = false;
}

function renderMessages() {
  const container = $('#messages');
  const query = state.query.trim().toLowerCase();
  const visible = state.messages.filter((message) => {
    if (state.filterAgent !== null && message.agent !== state.filterAgent) return false;
    if (query.length > 0 && !`${message.text}\n${message.agent}\n${message.to ?? ''}`.toLowerCase().includes(query)) return false;
    return true;
  });

  if (state.loading) {
    container.innerHTML = '<div class="empty"><div class="empty-mark">◈</div><h3>加载中…</h3></div>';
    return;
  }
  if (state.messages.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-mark"><svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/></svg></div>
        <h3>这个房间还没有消息</h3>
        <p>在下面以 <b>human</b> 的身份说句话，或者用右上角「接入」把 Claude / Codex / 其他 harness 拉进来。</p>
      </div>`;
    return;
  }
  if (visible.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-mark">⌕</div>
        <h3>没有匹配的消息</h3>
        <p>换个关键词，或清除当前筛选。</p>
      </div>`;
    return;
  }

  container.replaceChildren();
  let lastDay = null;
  let previous = null;
  for (const message of visible) {
    const day = new Date(message.ts).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      const divider = document.createElement('div');
      divider.className = 'day';
      divider.textContent = dayLabel(message.ts);
      container.append(divider);
      previous = null;
    }
    const compact = previous !== null
      && previous.agent === message.agent
      && Math.abs(new Date(message.ts).getTime() - new Date(previous.ts).getTime()) < 4 * 60 * 1000
      && !state.query;
    container.append(messageElement(message, compact));
    previous = message;
  }
  container.dataset.count = String(visible.length);
  renderFilterChips();
}

function messageElement(message, compact) {
  const isHuman = message.agent === 'human';
  const color = message.color ?? state.agents.get(message.agent)?.color ?? '#8b9bb4';
  const currentRoom = state.rooms.find((room) => room.id === state.currentRoom);
  const isPinned = currentRoom?.pinnedMessage?.id === message.id;
  const wrapper = document.createElement('div');
  wrapper.className = `msg${compact ? ' compact' : ''}${isHuman ? ' human' : ''}${message.kind === 'system' ? ' kind-system' : ''}`;
  wrapper.dataset.id = message.id;
  wrapper.style.setProperty('--who', color);
  wrapper.title = new Date(message.ts).toLocaleString();
  const role = message.role && !compact ? `<span class="role">${escapeHtml(message.role)}</span>` : '';
  const badge = message.kind && message.kind !== 'message' ? `<span class="badge ${escapeHtml(message.kind)}">${escapeHtml(KIND_LABEL[message.kind] ?? message.kind)}</span>` : '';
  const to = message.to ? `<span class="to">→ @${escapeHtml(message.to)}</span>` : '';
  const quoted = message.replyTo
    ? state.messages.find((entry) => entry.id === message.replyTo) ?? state.messages.find((entry) => String(entry.seq) === String(message.replyTo))
    : null;
  const quote = message.replyTo
    ? `<div class="msg-quote"><b>${escapeHtml(quoted?.agent ?? '消息')}</b><span>${escapeHtml(quoted ? quoted.text.replace(/\s+/gu, ' ').slice(0, 160) : `引用 ${String(message.replyTo).slice(0, 8)}`)}</span></div>`
    : '';
  wrapper.innerHTML = `
    <span class="msg-avatar">${avatarHtml(message.agent, color)}</span>
    <div class="msg-body">
      <div class="msg-head">
        <span class="who">${escapeHtml(message.agent)}</span>${role}${badge}${to}
        <span class="time">${timeLabel(message.ts)}</span>
        <button class="msg-pin${isPinned ? ' pinned' : ''}" title="${isPinned ? '取消置顶消息' : '置顶消息'}" aria-label="${isPinned ? '取消置顶消息' : '置顶消息'}"><svg viewBox="0 0 20 20"><path d="M7 3h6l-1 5 3 3v2h-4v4l-1 1-1-1v-4H5v-2l3-3z"/></svg></button>
        <button class="msg-reply" title="引用回复" aria-label="引用回复"><svg viewBox="0 0 20 20"><path d="M8 5L3 10l5 5M3 10h8a5 5 0 015 5v1"/></svg></button>
        <button class="msg-copy" title="复制消息" aria-label="复制消息"><svg viewBox="0 0 20 20"><rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 7V5a1 1 0 00-1-1H5a1 1 0 00-1 1v7a1 1 0 001 1h2"/></svg></button>
      </div>
      ${quote}
      <div class="bubble">${renderMarkdown(message.text)}</div>
    </div>`;
  wrapper.querySelector('.msg-copy').addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(message.text);
      toast('已复制');
    } catch {
      toast('复制失败');
    }
  });
  wrapper.querySelector('.msg-reply').addEventListener('click', (event) => {
    event.stopPropagation();
    setReply(message);
  });
  wrapper.querySelector('.msg-pin').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMessagePin(message);
  });
  if (message.text.length > 700) {
    const bubble = wrapper.querySelector('.bubble');
    bubble.classList.add('long');
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'msg-more';
    more.textContent = '展开全文';
    more.addEventListener('click', () => {
      const collapsed = bubble.classList.toggle('long');
      more.textContent = collapsed ? '展开全文' : '收起';
    });
    wrapper.querySelector('.msg-body').append(more);
  }
  const attachments = Array.isArray(message.meta?.attachments) ? message.meta.attachments : [];
  if (attachments.length > 0) {
    const box = document.createElement('div');
    box.className = 'msg-attachments';
    for (const attachment of attachments) {
      if (typeof attachment?.path !== 'string') continue;
      const link = document.createElement('a');
      link.className = `msg-attachment${isImageAttachment(attachment) ? ' has-thumb' : ''}`;
      link.href = attachmentUrl(attachment.path);
      link.download = attachment.name ?? 'file';
      link.target = '_blank';
      link.rel = 'noreferrer';
      const image = isImageAttachment(attachment)
        ? `<img class="attachment-thumb" src="${attachmentUrl(attachment.path, true)}" alt="" loading="lazy" />`
        : '<span class="attachment-icon">◈</span>';
      link.innerHTML = `${image}<span class="attachment-name">${escapeHtml(attachment.name ?? attachment.path)}</span><span class="attachment-size">${formatBytes(attachment.size)}</span>`;
      box.append(link);
    }
    if (box.childElementCount > 0) wrapper.querySelector('.msg-body').append(box);
  }
  return wrapper;
}

function renderContext() {
  const list = participants();
  const online = list.filter((participant) => state.agents.get(participant.agent)?.online).length;
  $('#statMessages').textContent = String(state.messages.length);
  $('#statParticipants').textContent = String(list.length);
  $('#statOnline').textContent = String(online);

  const container = $('#participants');
  container.replaceChildren();
  for (const participant of list) {
    const agent = state.agents.get(participant.agent);
    const row = document.createElement('div');
    row.className = 'participant';
    row.innerHTML = `
      ${avatarHtml(participant.agent, participant.color, 'width:24px;height:24px;border-radius:8px;font-size:9.5px')}
      <span class="p-meta">
        <span class="p-name">${escapeHtml(participant.agent)}</span>
        <span class="p-role">${escapeHtml(participant.role || agent?.role || (agent?.online ? '在线' : '离线'))}</span>
      </span>
      <span class="p-count">${participant.count}</span>
      <span class="status-dot${agent?.online ? ' online' : ''}"></span>
    `;
    row.addEventListener('click', () => toggleAgentFilter(participant.agent));
    container.append(row);
  }

  const decisions = state.messages.filter((message) => message.kind === 'decision').slice(-4).reverse();
  const dContainer = $('#decisions');
  dContainer.replaceChildren();
  if (decisions.length === 0) {
    dContainer.innerHTML = '<p class="muted" style="font-size:11.5px">还没有 decision 记录</p>';
  }
  for (const decision of decisions) {
    const item = document.createElement('div');
    item.className = 'decision-item';
    item.innerHTML = `<b>#${decision.seq} · ${escapeHtml(decision.agent)}</b><span>${escapeHtml(decision.text.slice(0, 160))}</span>`;
    dContainer.append(item);
  }
}

function renderAll() {
  renderMessages();
  renderFilterChips();
  renderAgents();
  renderContext();
  renderRooms();
  updateDocumentTitle();
}

/* ------------------------------------------------------------------ */
/* scrolling                                                           */
/* ------------------------------------------------------------------ */

function nearBottom() {
  const container = $('#messages');
  return container.scrollHeight - container.scrollTop - container.clientHeight < 140;
}

function scrollToBottom(smooth = true) {
  const container = $('#messages');
  container.scrollTo({ top: container.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  state.pendingNew = 0;
  updateJump();
}

function updateJump() {
  const button = $('#jumpLatest');
  if (state.pendingNew > 0 && !nearBottom()) {
    button.hidden = false;
    $('#jumpLabel').textContent = `${state.pendingNew} 条新消息`;
  } else if (state.pendingNew > 0) {
    button.hidden = false;
    $('#jumpLabel').textContent = `${state.pendingNew} 条新消息`;
  } else {
    button.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* tasks & workspace                                                   */
/* ------------------------------------------------------------------ */

const TASK_STATUS = { open: '待处理', in_progress: '进行中', review: '待评审', done: '已完成' };

async function loadTasks() {
  try {
    const data = await api('/api/tasks');
    state.tasks = data.tasks ?? [];
    if (typeof data.workspace === 'string') state.workspaceRoot = data.workspace;
    renderTasks();
  } catch {
    /* transient */
  }
}

function renderTasks() {
  const container = $('#taskList');
  if (container === null) return;
  container.replaceChildren();
  if (state.tasks.length === 0) {
    container.innerHTML = '<p class="ws-empty">还没有任务。点右上角 + 创建一个。</p>';
    return;
  }
  for (const task of state.tasks.slice(-6).reverse()) {
    const item = document.createElement('div');
    item.className = 'task-item';
    item.innerHTML = `
      <span class="task-title">${escapeHtml(task.title)}</span>
      <span class="task-meta">
        <span class="status-badge ${escapeHtml(task.status)}">${escapeHtml(TASK_STATUS[task.status] ?? task.status)}</span>
        <span>@${escapeHtml(task.assignee)}</span>
        ${task.reviewer ? `<span>· 评审 @${escapeHtml(task.reviewer)}</span>` : ''}
      </span>
    `;
    const actions = document.createElement('div');
    actions.className = 'task-actions';
    if (task.status !== 'done') {
      const done = document.createElement('button');
      done.className = 'chip';
      done.textContent = '标记完成';
      done.addEventListener('click', async (event) => {
        event.stopPropagation();
        await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
        await loadTasks();
      });
      actions.append(done);
    }
    const review = document.createElement('button');
    review.className = 'chip';
    review.textContent = '请评审';
    review.addEventListener('click', (event) => {
      event.stopPropagation();
      openReviewDialog(task);
    });
    actions.append(review);
    item.append(actions);
    container.append(item);
  }
}

function syncTaskReviewerOptions() {
  const assignee = $('#taskAssignee').value;
  const select = $('#taskReviewer');
  const previous = select.value;
  select.replaceChildren(new Option('暂不评审', ''));
  for (const [model, label] of [['claude', 'Claude'], ['codex', 'GPT / Codex'], ['dsh', 'DSH']]) {
    if (model !== assignee) select.append(new Option(label, model));
  }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function openTaskDialog() {
  $('#taskTitle').value = '';
  $('#taskDescription').value = '';
  $('#taskAssignee').value = 'codex';
  syncTaskReviewerOptions();
  $('#taskReviewer').value = '';
  $('#taskDialog').showModal();
  $('#taskTitle').focus();
}

async function createTask() {
  const title = $('#taskTitle').value.trim();
  if (!title) return;
  const assignee = $('#taskAssignee').value;
  const reviewer = $('#taskReviewer').value;
  try {
    await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title,
        description: $('#taskDescription').value.trim(),
        assignee,
        reviewer: reviewer || null,
        room: state.currentRoom,
        createdBy: 'human',
      }),
    });
    $('#taskDialog').close();
    await loadTasks();
    if (state.switches?.[assignee] === true) {
      toast('任务已创建并派发');
    } else {
      toast(`任务已创建，但 ${assignee} 开关关闭，任务不会自动执行；开启开关后请重新创建。`);
    }
  } catch (error) {
    toast(`创建任务失败：${error.message}`);
  }
}

function openReviewDialog(task) {
  state.reviewTaskId = task.id;
  $('#reviewTaskTitle').textContent = `任务：${task.title}（执行：${task.assignee}）`;
  const select = $('#reviewReviewer');
  select.replaceChildren(...['claude', 'codex', 'dsh']
    .filter((model) => model !== task.assignee)
    .map((model) => new Option(model, model)));
  $('#reviewNote').value = '';
  $('#reviewDialog').showModal();
}

async function sendReview() {
  if (state.reviewTaskId === null) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(state.reviewTaskId)}/review`, {
      method: 'POST',
      body: JSON.stringify({ reviewer: $('#reviewReviewer').value, note: $('#reviewNote').value.trim() }),
    });
    $('#reviewDialog').close();
    await loadTasks();
    toast('评审任务已派发');
  } catch (error) {
    toast(`派发评审失败：${error.message}`);
  }
}

async function loadWorkspace(path = '') {
  try {
    const data = await api(`/api/workspace/tree?path=${encodeURIComponent(path)}`);
    state.wsPath = data.path ?? '';
    state.wsEntries = data.entries ?? [];
    renderWorkspace();
  } catch (error) {
    toast(`读取工作区失败：${error.message}`);
  }
}

function renderWorkspace() {
  const tree = $('#wsTree');
  tree.replaceChildren();
  const crumbs = $('#wsBreadcrumb');
  crumbs.replaceChildren();
  const rootButton = document.createElement('button');
  rootButton.textContent = 'workspace';
  rootButton.addEventListener('click', () => loadWorkspace(''));
  crumbs.append(rootButton);
  let accumulated = '';
  for (const part of state.wsPath.split('/').filter(Boolean)) {
    accumulated = accumulated.length > 0 ? `${accumulated}/${part}` : part;
    const segment = document.createElement('button');
    segment.textContent = `/ ${part}`;
    const target = accumulated;
    segment.addEventListener('click', () => loadWorkspace(target));
    crumbs.append(segment);
  }
  if (state.wsEntries.length === 0) {
    tree.innerHTML = '<p class="ws-empty">空目录</p>';
  }
  for (const entry of state.wsEntries) {
    const row = document.createElement('div');
    row.className = 'ws-entry';
    row.innerHTML = `<span class="ws-kind">${entry.type === 'dir' ? '▸' : '·'}</span><span>${escapeHtml(entry.name)}</span>`;
    row.addEventListener('click', () => {
      if (entry.type === 'dir') loadWorkspace(entry.path);
      else openWorkspaceFile(entry.path);
    });
    tree.append(row);
  }
  $('#wsFilePath').textContent = '选择一个文件';
  $('#wsFileContent').value = '';
  $('#saveWorkspaceFile').hidden = true;
  $('#wsHint').textContent = `路径：${state.workspaceRoot || '(unknown)'} · 所有模型读写同一个目录`;
}

async function openWorkspaceFile(path) {
  try {
    const data = await api(`/api/workspace/file?path=${encodeURIComponent(path)}`);
    state.wsFile = data;
    $('#wsFilePath').textContent = data.path;
    const textarea = $('#wsFileContent');
    if (data.binary) {
      textarea.value = '(binary file — edit it with a local tool)';
      textarea.readOnly = true;
      $('#saveWorkspaceFile').hidden = true;
    } else {
      textarea.value = data.content ?? '';
      textarea.readOnly = false;
      $('#saveWorkspaceFile').hidden = false;
    }
  } catch (error) {
    toast(`读取文件失败：${error.message}`);
  }
}

async function saveWorkspaceFile() {
  if (state.wsFile === null || state.wsFile.binary) return;
  try {
    await api('/api/workspace/file', {
      method: 'PUT',
      body: JSON.stringify({ path: state.wsFile.path, content: $('#wsFileContent').value }),
    });
    toast('已保存');
    await loadWorkspace(state.wsPath);
  } catch (error) {
    toast(`保存失败：${error.message}`);
  }
}

async function loadWorkspacePreview() {
  try {
    const data = await api('/api/workspace/tree?path=');
    state.workspaceRoot = data.root ?? state.workspaceRoot;
    const container = $('#workspacePreview');
    container.replaceChildren();
    const entries = (data.entries ?? []).slice(0, 8);
    if (entries.length === 0) {
      container.innerHTML = '<p class="ws-empty">工作区是空的</p>';
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'ws-entry';
      row.innerHTML = `<span class="ws-kind">${entry.type === 'dir' ? '▸' : '·'}</span><span>${escapeHtml(entry.name)}</span>`;
      row.addEventListener('click', () => openWorkspace());
      container.append(row);
    }
  } catch {
    /* transient */
  }
}

function openWorkspace() {
  $('#workspaceDialog').showModal();
  loadWorkspace('');
}

/* ------------------------------------------------------------------ */
/* live stream                                                         */
/* ------------------------------------------------------------------ */

function connectStream() {
  if (state.stream) state.stream.close();
  const params = new URLSearchParams({ room: state.currentRoom });
  if (TOKEN) params.set('token', TOKEN);
  const stream = new EventSource(`${API_BASE}/api/stream?${params}`);
  state.stream = stream;

  stream.addEventListener('open', () => {
    state.connected = true;
    state.typing.clear();
    renderTyping();
    updateConnectionUI();
  });
  stream.addEventListener('error', () => {
    state.connected = false;
    updateConnectionUI();
  });
  stream.addEventListener('hello', (event) => {
    const data = JSON.parse(event.data);
    for (const agent of data.agents ?? []) upsertAgent(agent);
    renderAgents();
  });
  stream.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.room !== state.currentRoom) return;
    markTyping(message.agent, false);
    if (HIDDEN_AGENTS.has(message.agent)) return;
    if (state.seenIds.has(message.id)) return;
    state.seenIds.add(message.id);
    state.messages.push(message);
    state.cursor = Math.max(state.cursor, message.seq);
    markRoomRead(state.currentRoom, state.cursor);
    const wasNearBottom = nearBottom();
    const searching = state.query.length > 0 || state.filterAgent !== null;
    renderMessages();
    renderContext();
    renderRooms();
    if (wasNearBottom) scrollToBottom(true);
    else if (!searching) {
      state.pendingNew += 1;
      updateJump();
    }
  });
  stream.addEventListener('presence', (event) => {
    const data = JSON.parse(event.data);
    upsertAgent(data);
    renderAgents();
    renderContext();
  });
  stream.addEventListener('rooms', (event) => {
    const data = JSON.parse(event.data);
    if (Array.isArray(data.rooms)) {
      state.rooms = data.rooms;
      renderRooms();
      updateDocumentTitle();
    }
  });
  stream.addEventListener('switches', (event) => {
    const data = JSON.parse(event.data);
    if (data.switches !== undefined) {
      state.switches = data.switches;
      renderSwitches();
    }
  });
  stream.addEventListener('settings', (event) => {
    const data = JSON.parse(event.data);
    if (typeof data.settings?.fastReplies === 'boolean') {
      state.fastReplies = data.settings.fastReplies;
      $('#fastRepliesToggle').checked = state.fastReplies;
    }
    if (data.settings?.broadcastMode === 'all' || data.settings?.broadcastMode === 'single') {
      state.broadcastMode = data.settings.broadcastMode;
      $('#broadcastModeSelect').value = state.broadcastMode;
    }
  });
  stream.addEventListener('typing', (event) => {
    const data = JSON.parse(event.data);
    if (data.room !== state.currentRoom) return;
    if (data.typing === false && data.error === true) {
      const reason = typeof data.reason === 'string' && data.reason.length > 0 ? `：${data.reason}` : '';
      toast(`${data.agent} 未回复${reason}`);
    }
    markTyping(data.agent, data.typing === true);
  });
  stream.addEventListener('tasks', (event) => {
    const data = JSON.parse(event.data);
    if (Array.isArray(data.tasks)) {
      state.tasks = data.tasks;
      renderTasks();
    }
  });
}

function updateConnectionUI() {
  const dot = $('#connDot');
  dot.classList.toggle('live', state.connected);
  dot.classList.toggle('dead', !state.connected);
  $('#connText').textContent = state.connected ? '实时连接' : '重连中…';
}

/* ------------------------------------------------------------------ */
/* composer                                                            */
/* ------------------------------------------------------------------ */

function updateComposerHeight() {
  const textarea = $('#text');
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
}

function setReply(message) {
  state.replyTo = message;
  const snippet = String(message.text).replace(/\s+/gu, ' ').slice(0, 120);
  $('#replyBarText').textContent = `${message.agent}: ${snippet}`;
  $('#replyBar').hidden = false;
  $('#text').focus();
}

function clearReply() {
  state.replyTo = null;
  $('#replyBar').hidden = true;
  $('#replyBarText').textContent = '';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isImageAttachment(attachment) {
  return /\.(png|jpe?g|gif|webp|avif|svg)$/iu.test(String(attachment?.name ?? attachment?.path ?? ''));
}

function attachmentUrl(path, inline = false) {
  return `${API_BASE}/api/workspace/download?path=${encodeURIComponent(path)}${inline ? '&inline=1' : ''}`;
}

function renderAttachments() {
  const box = $('#pendingAttachments');
  box.replaceChildren();
  box.hidden = state.attachments.length === 0;
  for (const attachment of state.attachments) {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    const thumb = isImageAttachment(attachment)
      ? `<img class="attachment-thumb" src="${attachmentUrl(attachment.path, true)}" alt="" />`
      : '<span class="attachment-icon">◈</span>';
    chip.innerHTML = `${thumb}<span class="attachment-name">${escapeHtml(attachment.name)}</span><span class="attachment-size">${formatBytes(attachment.size)}</span>`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.textContent = '×';
    remove.title = '移除附件';
    remove.addEventListener('click', () => {
      state.attachments = state.attachments.filter((entry) => entry.path !== attachment.path);
      renderAttachments();
    });
    chip.append(remove);
    box.append(chip);
  }
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;
  for (const file of files) {
    if (file.size > 30 * 1024 * 1024) {
      toast(`${file.name} 超过 30 MB，已跳过`);
      continue;
    }
    const headers = {};
    if (TOKEN) headers['x-hub-token'] = TOKEN;
    try {
      toast(`正在上传 ${file.name}…`);
      const response = await fetch(`${API_BASE}/api/workspace/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers,
        body: file,
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      state.attachments.push({ name: data.file.name, path: data.file.path, size: data.file.size });
      renderAttachments();
      await loadWorkspacePreview();
      toast(`${file.name} 已上传到工作区`);
    } catch (error) {
      toast(`上传失败：${error.message}`);
    }
  }
  $('#fileInput').value = '';
}

async function sendMessage() {
  const attachments = [...state.attachments];
  const text = $('#text').value.trim() || (attachments.length > 0 ? `上传了 ${attachments.length} 个文件` : '');
  if (text.length === 0) return;
  const button = $('#sendBtn');
  button.disabled = true;
  try {
    const payload = {
      agent: $('#sendAs').value || 'human',
      kind: $('#kind').value,
      text,
    };
    const to = $('#to').value;
    if (to) payload.to = to;
    const broadcast = to.length === 0 && !mentionsModel(text);
    if (state.replyTo !== null) payload.replyTo = state.replyTo.id;
    if (payload.agent === 'human') payload.role = '你（人类）';
    if (attachments.length > 0) payload.meta = { attachments };
    const data = await api(`/api/rooms/${encodeURIComponent(state.currentRoom)}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (broadcast) {
      const enabled = ['claude', 'codex', 'dsh'].filter((model) => state.switches?.[model] === true);
      if (enabled.length === 0) toast('已发送给所有人，但所有模型开关都关闭，不会自动回复');
      else if (enabled.length > 1) toast(`已广播给 ${enabled.length} 个模型，回复可能需要一会儿`);
    }
    $('#text').value = '';
    state.attachments = [];
    renderAttachments();
    clearReply();
    $('#charCount').textContent = '0';
    updateComposerHeight();
    if (!state.seenIds.has(data.message.id)) {
      state.seenIds.add(data.message.id);
      state.messages.push(data.message);
      state.cursor = data.cursor ?? state.cursor;
      markRoomRead(state.currentRoom, state.cursor);
      renderMessages();
      renderContext();
      renderRooms();
      scrollToBottom(true);
    }
  } catch (error) {
    toast(`发送失败：${error.message}`);
  } finally {
    button.disabled = false;
    $('#text').focus();
  }
}

/* ------------------------------------------------------------------ */
/* dialogs                                                             */
/* ------------------------------------------------------------------ */

function buildInviteCommands() {
  const origin = HUB_ORIGIN;
  const appPath = 'B:\\documents\\agent-hub';
  $('#inviteConnect').textContent = `cd ${appPath}\nnode connect.mjs all\n\n# 只接一家：\nnode connect.mjs claude\nnode connect.mjs codex`;
  $('#inviteCli').textContent = [
    `cd ${appPath}`,
    `node cli.mjs join --agent my-agent --role "my harness"`,
    `node cli.mjs send --agent my-agent --room general --text "hello from my-agent"`,
    `node cli.mjs read --agent my-agent --room general --limit 30`,
    `node cli.mjs wait --agent my-agent --room general --since 0 --timeout 120`,
  ].join('\n');
  $('#inviteMcp').textContent = [
    'Claude Code:',
    `claude mcp add agent-hub --scope user -- node "${appPath}\\mcp.mjs" --agent claude --url ${origin}`,
    '',
    'Codex CLI:',
    `codex mcp add agent-hub --env HUB_AGENT=codex -- node "${appPath}\\mcp.mjs" --agent codex --url ${origin}`,
  ].join('\n');
  $('#inviteHttp').textContent = [
    `GET  ${origin}/api/rooms`,
    `GET  ${origin}/api/rooms/general/messages?since=0&limit=50`,
    `POST ${origin}/api/rooms/general/messages`,
    '     {"agent":"claude","kind":"message","text":"hello"}',
    `GET  ${origin}/api/stream?room=general     # SSE`,
    '',
    'Hub 本身只做协调，不提供文件/命令工具；需要工具的 agent 请用 MCP 接入，',
    '纯 HTTP harness 可直接调 API（示例：node examples/api-client.mjs send --text hi）。',
  ].join('\n');
  $('#inviteTokenLine').textContent = TOKEN
    ? '当前实例启用了 HUB_TOKEN：API 需带 x-hub-token，SSE 加 ?token=<token>。'
    : '当前实例无需 token（仅监听本机）。';
}

/* ------------------------------------------------------------------ */
/* init & events                                                       */
/* ------------------------------------------------------------------ */

function updateDocumentTitle() {
  const unread = state.rooms.reduce((sum, room) => (room.id === state.currentRoom ? sum : sum + unreadFor(room)), 0);
  const room = state.rooms.find((entry) => entry.id === state.currentRoom);
  document.title = `${unread > 0 ? `(${unread}) ` : ''}Agent Hub · ${room?.name ?? state.currentRoom}`;
}

function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#backdrop').hidden = false;
  $('#menuBtn').setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#backdrop').hidden = true;
  $('#menuBtn').setAttribute('aria-expanded', 'false');
}

const SECTION_IDS = { agents: 'agentsSection', switches: 'switchesSection' };
const ACCENTS = {
  indigo: { accent: '#4f46e5', strong: '#4338ca', soft: '#eef2ff' },
  blue: { accent: '#2563eb', strong: '#1d4ed8', soft: '#eff6ff' },
  teal: { accent: '#0d9488', strong: '#0f766e', soft: '#f0fdfa' },
  orange: { accent: '#ea580c', strong: '#c2410c', soft: '#fff7ed' },
};

function applyAppearance() {
  const accent = ACCENTS[localStorage.getItem('hub.accent')] ?? ACCENTS.indigo;
  document.documentElement.style.setProperty('--accent', accent.accent);
  document.documentElement.style.setProperty('--accent-strong', accent.strong);
  document.documentElement.style.setProperty('--accent-soft', accent.soft);
  document.documentElement.style.setProperty('--msg-size', `${localStorage.getItem('hub.msgSize') ?? '13.4'}px`);
  document.body.classList.toggle('compact-ui', localStorage.getItem('hub.density') === 'compact');
}

function initAppearance() {
  applyAppearance();
  const accentSelect = $('#accentSelect');
  const fontSelect = $('#fontSizeSelect');
  const densitySelect = $('#densitySelect');
  accentSelect.value = localStorage.getItem('hub.accent') ?? 'indigo';
  fontSelect.value = localStorage.getItem('hub.msgSize') ?? '13.4';
  densitySelect.value = localStorage.getItem('hub.density') ?? 'comfortable';
  const save = () => {
    localStorage.setItem('hub.accent', accentSelect.value);
    localStorage.setItem('hub.msgSize', fontSelect.value);
    localStorage.setItem('hub.density', densitySelect.value);
    applyAppearance();
  };
  accentSelect.addEventListener('change', save);
  fontSelect.addEventListener('change', save);
  densitySelect.addEventListener('change', save);
  $('#settingsBtn').addEventListener('click', () => $('#settingsDialog').showModal());
  $('#resetAppearance').addEventListener('click', () => {
    localStorage.removeItem('hub.accent');
    localStorage.removeItem('hub.msgSize');
    localStorage.removeItem('hub.density');
    accentSelect.value = 'indigo';
    fontSelect.value = '13.4';
    densitySelect.value = 'comfortable';
    applyAppearance();
  });
}
function setSectionCollapsed(name, collapsed) {
  const section = document.getElementById(SECTION_IDS[name]);
  if (section === null) return;
  section.classList.toggle('collapsed', collapsed);
  const head = section.querySelector('[data-section]');
  if (head !== null) head.setAttribute('aria-expanded', String(!collapsed));
  localStorage.setItem(`hub.section.${name}`, collapsed ? '1' : '0');
}
function initCollapsibleSections() {
  for (const [name, sectionId] of Object.entries(SECTION_IDS)) {
    const section = document.getElementById(sectionId);
    section.classList.toggle('collapsed', localStorage.getItem(`hub.section.${name}`) === '1');
    const head = section.querySelector('[data-section]');
    head.setAttribute('aria-expanded', String(!section.classList.contains('collapsed')));
    const toggle = () => setSectionCollapsed(name, !section.classList.contains('collapsed'));
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
  }
}

function showOffline(error) {
  state.connected = false;
  updateConnectionUI();
  $('#connText').textContent = '无法连接 Hub';
  $('#connDot').classList.add('dead');
  $('#versionLine').textContent = 'Agent Hub · offline';
  $('#roomTopic').textContent = `无法连接 ${HUB_ORIGIN}`;
  $('#messages').innerHTML = `
    <div class="empty">
      <div class="empty-mark">◈</div>
      <h3>连不上 Agent Hub 服务</h3>
      <p>当前地址：<code>${escapeHtml(HUB_ORIGIN)}</code></p>
      <pre class="code">cd B:\\documents\\agent-hub
node start.mjs --open
# 或双击 start.cmd</pre>
      <p class="muted">${escapeHtml(error?.message ?? 'network error')}</p>
    </div>`;
}

function setFocusMode(enabled) {
  document.body.classList.toggle('focus-mode', enabled);
  $('#focusBtn').setAttribute('aria-pressed', String(enabled));
  localStorage.setItem('hub.focusMode', enabled ? '1' : '0');
  requestAnimationFrame(() => scrollToBottom(false));
}

function setupResizers() {
  const shell = document.querySelector('.shell');
  const apply = (name, width) => shell.style.setProperty(name, `${Math.round(width)}px`);
  const savedSide = Number(localStorage.getItem('hub.sidebarWidth'));
  const savedContext = Number(localStorage.getItem('hub.contextWidth'));
  if (Number.isFinite(savedSide) && savedSide >= 200) apply('--sidebar-w', Math.min(380, savedSide));
  if (Number.isFinite(savedContext) && savedContext >= 240) apply('--context-w', Math.min(480, savedContext));

  const bind = (handle, side) => {
    if (handle === null) return;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      if (window.innerWidth <= 720 || document.body.classList.contains('focus-mode')) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      const startX = event.clientX;
      const variable = side === 'left' ? '--sidebar-w' : '--context-w';
      const startWidth = parseFloat(getComputedStyle(shell).getPropertyValue(variable)) || (side === 'left' ? 240 : 280);
      const shellWidth = shell.getBoundingClientRect().width;
      const maxWidth = Math.max(260, side === 'left' ? Math.min(380, shellWidth - 640) : Math.min(480, shellWidth - 620));
      const minWidth = side === 'left' ? 200 : 240;
      const move = (moveEvent) => {
        const delta = side === 'left' ? moveEvent.clientX - startX : startX - moveEvent.clientX;
        const width = Math.max(minWidth, Math.min(maxWidth, startWidth + delta));
        apply(variable, width);
      };
      const stop = () => {
        handle.classList.remove('dragging');
        handle.removeEventListener('pointermove', move);
        const width = parseFloat(getComputedStyle(shell).getPropertyValue(variable));
        if (Number.isFinite(width)) localStorage.setItem(side === 'left' ? 'hub.sidebarWidth' : 'hub.contextWidth', String(Math.round(width)));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop, { once: true });
      handle.addEventListener('pointercancel', stop, { once: true });
    });
  };
  bind($('#resizerLeft'), 'left');
  bind($('#resizerRight'), 'right');
}

function setupUploadDrop() {
  const composer = $('#composer');
  const hasFiles = (event) => event.dataTransfer !== null && Array.from(event.dataTransfer.types ?? []).includes('Files');
  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    composer.classList.add('drag-over');
  });
  document.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null) composer.classList.remove('drag-over');
  });
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    composer.classList.remove('drag-over');
    uploadFiles(event.dataTransfer.files);
  });
  $('#text').addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length > 0) {
      event.preventDefault();
      uploadFiles(files);
    }
  });
}

async function init() {
  initCollapsibleSections();
  initAppearance();
  setupResizers();
  setupUploadDrop();
  setFocusMode(localStorage.getItem('hub.focusMode') === '1');
  try {
    const health = await api('/api/health');
    $('#versionLine').textContent = `Agent Hub v${health.version}`;
    const agents = await api('/api/agents');
    for (const agent of agents.agents) upsertAgent(agent);
    const switchData = await api('/api/switches');
    state.switches = switchData.switches;
    const settingsData = await api('/api/settings');
    state.fastReplies = settingsData.settings?.fastReplies !== false;
    state.broadcastMode = settingsData.settings?.broadcastMode === 'single' ? 'single' : 'all';
    $('#fastRepliesToggle').checked = state.fastReplies;
    $('#broadcastModeSelect').value = state.broadcastMode;
    renderSwitches();
    renderAgents();
    await loadRooms();
    await loadTasks();
    await loadWorkspacePreview();
    setInterval(() => { if (state.typing.size > 0) renderTyping(); }, 1000);
    if (!state.rooms.some((room) => room.id === state.currentRoom)) state.currentRoom = state.rooms[0]?.id ?? 'general';
    await selectRoom(state.currentRoom);
    setInterval(async () => {
      try {
        const { rooms } = await api('/api/rooms');
        state.rooms = rooms;
        renderRooms();
        updateDocumentTitle();
      } catch {
        /* transient */
      }
    }, 8000);
  } catch (error) {
    showOffline(error);
  }
}

$('#attachBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (event) => uploadFiles(event.target.files));
$('#cancelReply').addEventListener('click', clearReply);
$('#fastRepliesToggle').addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  try {
    const data = await api('/api/settings', { method: 'POST', body: JSON.stringify({ fastReplies: enabled }) });
    state.fastReplies = data.settings?.fastReplies === true;
    toast(state.fastReplies ? '快速回复已开启（低推理）' : '快速回复已关闭（使用本机默认推理）');
  } catch (error) {
    event.target.checked = state.fastReplies;
    toast(`设置失败：${error.message}`);
  }
});
$('#broadcastModeSelect').addEventListener('change', async (event) => {
  try {
    const data = await api('/api/settings', { method: 'POST', body: JSON.stringify({ broadcastMode: event.target.value }) });
    state.broadcastMode = data.settings?.broadcastMode === 'single' ? 'single' : 'all';
    toast(state.broadcastMode === 'single' ? '所有人消息：只让一个模型回复' : '所有人消息：全部开启的模型都回复');
  } catch (error) {
    event.target.value = state.broadcastMode;
    toast(`设置失败：${error.message}`);
  }
});

$('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});
$('#text').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
$('#text').addEventListener('input', () => {
  $('#charCount').textContent = String($('#text').value.length);
  updateComposerHeight();
});

$('#searchInput').addEventListener('input', () => {
  state.query = $('#searchInput').value;
  const query = state.query.trim();
  const filtered = state.messages.filter((message) => query.length === 0 || `${message.text}\n${message.agent}`.toLowerCase().includes(query.toLowerCase()));
  $('#searchResult').textContent = query.length > 0 ? `${filtered.length} 条匹配` : '';
  renderFilterChips();
  renderMessages();
});

$('#clearFilter').addEventListener('click', () => {
  state.filterAgent = null;
  state.query = '';
  $('#searchInput').value = '';
  $('#searchResult').textContent = '';
  renderFilterChips();
  renderAgents();
  renderMessages();
});

$('#jumpLatest').addEventListener('click', () => scrollToBottom(true));
$('#messages').addEventListener('scroll', () => {
  if (nearBottom()) {
    state.pendingNew = 0;
    updateJump();
  } else if (state.pendingNew > 0) {
    updateJump();
  } else {
    $('#jumpLatest').hidden = true;
  }
});

$('#refreshBtn').addEventListener('click', async () => {
  await loadRooms();
  await selectRoom(state.currentRoom);
  toast('已刷新');
});
$('#focusBtn').addEventListener('click', () => setFocusMode(!document.body.classList.contains('focus-mode')));
$('#roomManageBtn').addEventListener('click', openRoomManage);
$('#closeRoomManage').addEventListener('click', () => $('#roomManageDialog').close());
$('#managePin').addEventListener('click', () => {
  const room = state.rooms.find((entry) => entry.id === state.currentRoom);
  $('#roomManageDialog').close();
  if (room !== undefined) togglePin(room);
});
$('#manageDelete').addEventListener('click', async () => {
  const room = state.rooms.find((entry) => entry.id === state.currentRoom);
  $('#roomManageDialog').close();
  if (room === undefined) return;
  const ok = await askConfirm('删除房间', deleteRoomMessage(room), '删除');
  if (ok) await deleteRoom(room);
});
$('#pinRoomBtn').addEventListener('click', () => {
  const room = state.rooms.find((entry) => entry.id === state.currentRoom);
  if (room !== undefined) togglePin(room);
});
$('#pinnedJump').addEventListener('click', () => {
  const room = state.rooms.find((entry) => entry.id === state.currentRoom);
  const pinned = room?.pinnedMessage;
  if (pinned === undefined || pinned === null) return;
  const element = document.querySelector(`.msg[data-id="${pinned.id}"]`);
  if (element === null) {
    toast('这条置顶消息不在当前已加载的消息范围内');
    return;
  }
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element.classList.add('flash');
  setTimeout(() => element.classList.remove('flash'), 1200);
});
$('#unpinMessage').addEventListener('click', () => {
  const room = state.rooms.find((entry) => entry.id === state.currentRoom);
  if (room?.pinnedMessage !== null && room?.pinnedMessage !== undefined) {
    toggleMessagePin({ id: room.pinnedMessage.id });
  }
});
$('#deleteRoomBtn').addEventListener('click', async () => {
  const room = state.rooms.find((entry) => entry.id === state.currentRoom);
  if (room === undefined) return;
  const ok = await askConfirm('删除房间', deleteRoomMessage(room), '删除');
  if (ok) await deleteRoom(room);
});
$('#menuBtn').addEventListener('click', openSidebar);
$('#sidebarClose').addEventListener('click', closeSidebar);
$('#backdrop').addEventListener('click', closeSidebar);
$('#confirmCancel').addEventListener('click', () => settleConfirm(false));
$('#confirmOk').addEventListener('click', () => settleConfirm(true));
$('#confirmDialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  settleConfirm(false);
});

function goHome() {
  closeSidebar();
  if (state.rooms.some((room) => room.id === 'general')) {
    selectRoom('general');
  } else if (state.rooms.length > 0) {
    selectRoom(state.rooms[0].id);
  }
}
$('#brandHome').addEventListener('click', goHome);
$('#brandHome').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    goHome();
  }
});

$('#newRoomBtn').addEventListener('click', () => {
  $('#roomNameInput').value = '';
  $('#roomTopicInput').value = '';
  $('#roomDialog').showModal();
  $('#roomNameInput').focus();
});

$('#newTaskBtn').addEventListener('click', openTaskDialog);
$('#taskAssignee').addEventListener('change', syncTaskReviewerOptions);
$('#createTaskBtn').addEventListener('click', (event) => { event.preventDefault(); createTask(); });
$('#cancelTask').addEventListener('click', () => $('#taskDialog').close());
$('#sendReviewBtn').addEventListener('click', (event) => { event.preventDefault(); sendReview(); });
$('#cancelReview').addEventListener('click', () => $('#reviewDialog').close());
$('#openWorkspaceBtn').addEventListener('click', openWorkspace);
$('#closeWorkspace').addEventListener('click', () => $('#workspaceDialog').close());
$('#saveWorkspaceFile').addEventListener('click', saveWorkspaceFile);
$('#roomForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter !== undefined && event.submitter !== null && event.submitter.value !== 'create') {
    $('#roomDialog').close();
    return;
  }
  const name = $('#roomNameInput').value.trim();
  if (!name) return;
  try {
    const data = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name, topic: $('#roomTopicInput').value.trim() }) });
    $('#roomDialog').close();
    await loadRooms();
    await selectRoom(data.room.id);
    toast(`房间 #${data.room.name} 已就绪`);
  } catch (error) {
    toast(`创建失败：${error.message}`);
  }
});
$('#cancelRoom').addEventListener('click', () => $('#roomDialog').close());

$('#inviteBtn').addEventListener('click', () => {
  buildInviteCommands();
  $('#inviteDialog').showModal();
});
$('#closeInvite').addEventListener('click', () => $('#inviteDialog').close());
$('#copyInvite').addEventListener('click', async () => {
  const text = [$('#inviteConnect').textContent, $('#inviteCli').textContent, $('#inviteMcp').textContent, $('#inviteHttp').textContent].join('\n\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制接入命令');
  } catch {
    toast('复制失败');
  }
});

document.addEventListener('keydown', (event) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (event.key === '/' && !typing) {
    event.preventDefault();
    $('#searchInput').focus();
  } else if (event.key === 'Escape') {
    if (state.query.length > 0 || state.filterAgent !== null) {
      state.query = '';
      state.filterAgent = null;
      $('#searchInput').value = '';
      $('#searchResult').textContent = '';
      renderFilterChips();
      renderAgents();
      renderMessages();
    }
    if (state.replyTo !== null) clearReply();
    closeSidebar();
  }
});

init();
