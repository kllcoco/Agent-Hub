#!/usr/bin/env node
/**
 * Agent Hub — a tiny shared coordination space for multiple agent harnesses.
 *
 * One process serves:
 *   - REST API for agents (rooms, messages, presence)
 *   - Server-Sent Events for live updates
 *   - a static web dashboard so a human can watch every participant
 *
 * No external dependencies. State lives in ./data as JSON + JSONL.
 */
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = process.env.HUB_DATA ? join(process.env.HUB_DATA) : join(ROOT, 'data');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const TOKEN = process.env.HUB_TOKEN ?? '';
const PRESENCE_TTL_MS = Number(process.env.HUB_PRESENCE_TTL_MS ?? 120_000);
const MAX_TEXT = 32_768;
const MAX_BODY = 1_048_576;
const MAX_UPLOAD = 30 * 1024 * 1024;
const VERSION = '1.0.0';

const AGENT_COLORS = {
  claude: '#d97757',
  codex: '#10a37f',
  chatgpt: '#10a37f',
  openai: '#10a37f',
  dsh: '#4d6bfe',
  deepseek: '#4d6bfe',
  gemini: '#4285f4',
  human: '#f0b429',
};
const FALLBACK_COLORS = ['#7c9cff', '#e07be0', '#38bdf8', '#f472b6', '#a3e635', '#fb923c', '#c084fc', '#2dd4bf'];

mkdirSync(join(DATA_DIR, 'rooms'), { recursive: true });

/** @typedef {{id:string, name:string, topic:string, createdAt:string, messages:any[], seq:number}} Room */

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, {agent:string, role:string, color:string, lastSeen:number, firstSeen:number}>} */
const presence = new Map();
/** @type {Set<{res:import('node:http').ServerResponse, room:string|null}>} */
const streamClients = new Set();

/** Per-model invocation switches, controlled by the human (quota guard). */
const DEFAULT_SWITCHES = { claude: false, codex: false, dsh: true };
const switchesFile = join(DATA_DIR, 'switches.json');
const switches = { ...DEFAULT_SWITCHES, updatedAt: null };

/** Global reply-speed setting (low reasoning by default). */
const settingsFile = join(DATA_DIR, 'settings.json');
const settings = { fastReplies: true, broadcastMode: 'all' };

/** Per-model worker settings: preferred model id and a fast/low-reasoning mode. */
const DEFAULT_MODELS = {
  claude: { model: '', fast: true },
  codex: { model: '', fast: true },
  dsh: { model: '', fast: true },
};
const modelsFile = join(DATA_DIR, 'models.json');
const models = JSON.parse(JSON.stringify(DEFAULT_MODELS));

/** agent -> room -> timestamp of a typing indicator. */
const typing = new Map();

/** Shared workspace where every model can read/write files. */
const WORKSPACE_DIR = process.env.HUB_WORKSPACE ? resolve(process.env.HUB_WORKSPACE) : join(ROOT, 'workspace');
mkdirSync(join(WORKSPACE_DIR, 'notes'), { recursive: true });
if (!existsSync(join(WORKSPACE_DIR, 'README.md'))) {
  writeFileSync(join(WORKSPACE_DIR, 'README.md'), [
    '# Shared team workspace',
    '',
    'All models (Claude, GPT/Codex, DSH) and the human work in this directory.',
    'Read the hub messages first, then edit files here directly.',
    'When you disagree with another model, point it out in the hub and fix the file.',
    '',
    '## Conventions',
    '- Keep changes small and explain them in a `decision` hub message.',
    '- Mention the file paths you touched.',
    '- Read a file before editing it, and re-read after others may have changed it.',
    '',
  ].join('\n'));
}

/** Task board: user requirements dispatched to models. */
const tasksFile = join(DATA_DIR, 'tasks.json');
/** @type {Array<Record<string, any>>} */
let tasks = [];


const nowIso = () => new Date().toISOString();
const log = (...args) => console.log(`[${nowIso()}]`, ...args);

function slugify(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
  return slug || `room-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeAgent(value) {
  const agent = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/u.test(agent)) return undefined;
  return agent;
}

function colorFor(agent) {
  const key = agent.toLowerCase();
  if (AGENT_COLORS[key]) return AGENT_COLORS[key];
  const known = Object.keys(AGENT_COLORS).find((name) => key.startsWith(name));
  if (known) return AGENT_COLORS[known];
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

function roomFile(id) {
  return join(DATA_DIR, 'rooms', `${id}.jsonl`);
}

const roomsMetaFile = join(DATA_DIR, 'rooms.json');

function loadState() {
  let meta = [];
  if (existsSync(roomsMetaFile)) {
    try {
      meta = JSON.parse(readFileSync(roomsMetaFile, 'utf8'));
    } catch (error) {
      log('rooms.json is corrupt, starting with an empty registry:', error.message);
    }
  }
  if (!Array.isArray(meta) || meta.length === 0) meta = [{ id: 'general', name: 'general', topic: 'Shared work space for every agent and the human.', createdAt: nowIso() }];

  for (const entry of meta) {
    const id = typeof entry.id === 'string' ? entry.id : slugify(entry.name);
    const room = {
      id,
      name: typeof entry.name === 'string' ? entry.name : id,
      topic: typeof entry.topic === 'string' ? entry.topic : '',
      createdAt: entry.createdAt ?? nowIso(),
      pinned: entry.pinned === true,
      pinnedMessageId: typeof entry.pinnedMessageId === 'string' ? entry.pinnedMessageId : null,
      messages: [],
      seq: 0,
    };
    const file = roomFile(id);
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
        if (line.trim().length === 0) continue;
        try {
          const message = JSON.parse(line);
          room.messages.push(message);
          if (Number.isInteger(message.seq) && message.seq > room.seq) room.seq = message.seq;
        } catch {
          // Skip a corrupt line instead of losing the whole room.
        }
      }
    }
    rooms.set(id, room);
  }
  if (!rooms.has('general')) {
    rooms.set('general', { id: 'general', name: 'general', topic: 'Shared work space for every agent and the human.', createdAt: nowIso(), pinned: false, pinnedMessageId: null, messages: [], seq: 0 });
  }
  if (!existsSync(roomsMetaFile)) saveRoomsMeta();
  if (existsSync(switchesFile)) {
    try {
      const saved = JSON.parse(readFileSync(switchesFile, 'utf8'));
      for (const key of Object.keys(DEFAULT_SWITCHES)) {
        if (typeof saved[key] === 'boolean') switches[key] = saved[key];
      }
      switches.updatedAt = typeof saved.updatedAt === 'string' ? saved.updatedAt : null;
    } catch (error) {
      log('switches.json is corrupt, using defaults:', error.message);
    }
  }
  if (existsSync(modelsFile)) {
    try {
      const saved = JSON.parse(readFileSync(modelsFile, 'utf8'));
      for (const key of Object.keys(DEFAULT_MODELS)) {
        if (typeof saved[key]?.model === 'string') models[key].model = saved[key].model.slice(0, 120);
        if (typeof saved[key]?.fast === 'boolean') models[key].fast = saved[key].fast;
      }
    } catch (error) {
      log('models.json is corrupt, using defaults:', error.message);
    }
  }
  if (existsSync(tasksFile)) {
    try {
      const saved = JSON.parse(readFileSync(tasksFile, 'utf8'));
      if (Array.isArray(saved)) tasks = saved;
    } catch (error) {
      log('tasks.json is corrupt, starting empty:', error.message);
    }
  }
  if (existsSync(settingsFile)) {
    try {
      const saved = JSON.parse(readFileSync(settingsFile, 'utf8'));
      if (typeof saved.fastReplies === 'boolean') settings.fastReplies = saved.fastReplies;
      if (saved.broadcastMode === 'all' || saved.broadcastMode === 'single') settings.broadcastMode = saved.broadcastMode;
    } catch (error) {
      log('settings.json is corrupt, using defaults:', error.message);
    }
  }
}

function saveSettings() {
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
}

function saveModels() {
  writeFileSync(modelsFile, JSON.stringify(models, null, 2) + '\n');
}

function modelSnapshot() {
  return JSON.parse(JSON.stringify(models));
}

function saveTasks() {
  writeFileSync(tasksFile, JSON.stringify(tasks, null, 2) + '\n');
}

function taskById(id) {
  return tasks.find((task) => task.id === id);
}

function broadcastTasks() {
  broadcast('tasks', { tasks });
}

/** Resolve a relative workspace path and refuse anything outside the workspace root. */
function resolveWorkspacePath(input) {
  const clean = String(input ?? '').replace(/^[/\\]+/u, '');
  const absolute = resolve(WORKSPACE_DIR, clean);
  if (absolute !== WORKSPACE_DIR && !absolute.startsWith(WORKSPACE_DIR + sep)) {
    throw new HttpError(403, 'path escapes the workspace');
  }
  return absolute;
}

function workspaceEntries(absolute) {
  const entries = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const child = join(absolute, entry.name);
    let size = 0;
    let mtime = null;
    try {
      const stat = statSync(child);
      size = stat.size;
      mtime = stat.mtime.toISOString();
    } catch {
      /* unreadable */
    }
    entries.push({
      name: entry.name,
      path: relative(WORKSPACE_DIR, child).split(sep).join('/'),
      type: entry.isDirectory() ? 'dir' : 'file',
      size,
      mtime,
    });
  }
  entries.sort((left, right) => Number(right.type === 'dir') - Number(left.type === 'dir') || left.name.localeCompare(right.name));
  return entries.slice(0, 300);
}

function appendTaskMessage(task, target, mode = 'task', note = '') {
  const room = rooms.get(task.room);
  if (room === undefined) return undefined;
  const workspace = WORKSPACE_DIR;
  const intro = mode === 'review'
    ? `[task:${task.id}:review] 请评审并修正这个任务的结果：「${task.title}」\n\n${note ? `评审重点：${note}\n\n` : ''}原始要求：${task.description || '(无补充说明)'}\n被评审模型：${task.assignee}`
    : `[task:${task.id}] ${task.title}\n\n${task.description || '(无补充说明)'}`;
  const text = [
    intro,
    '',
    `工作区：${workspace}`,
    `先读 hub 房间 ${task.room} 的最近消息（hub_read，since 0）和工作区里的相关文件，再动手。`,
    '你可以直接指出并修正其他模型的错误；改完文件后在 hub 用 kind=decision 汇报，to=human。',
    '回复要说明：你读了什么、改了什么、还有哪些不确定。',
  ].join('\n');
  const message = appendMessage(room, {
    agent: 'human',
    role: '你（人类）',
    kind: 'task',
    to: target,
    text,
    meta: { taskId: task.id, ...(mode === 'review' ? { review: true } : {}) },
  });
  return message;
}

function saveSwitches() {
  writeFileSync(switchesFile, JSON.stringify({ ...switches }, null, 2) + '\n');
}

function switchSnapshot() {
  return { ...switches };
}

function saveRoomsMeta() {
  const meta = [...rooms.values()].map(({ id, name, topic, createdAt, pinned, pinnedMessageId }) => ({
    id,
    name,
    topic,
    createdAt,
    pinned: pinned === true,
    pinnedMessageId: pinnedMessageId ?? null,
  }));
  writeFileSync(roomsMetaFile, JSON.stringify(meta, null, 2) + '\n');
}

function pinnedMessageSummary(room) {
  if (typeof room.pinnedMessageId !== 'string') return null;
  const message = room.messages.find((entry) => entry.id === room.pinnedMessageId);
  if (message === undefined) return null;
  return {
    id: message.id,
    seq: message.seq,
    agent: message.agent,
    role: message.role ?? '',
    text: message.text,
    ts: message.ts,
    kind: message.kind,
  };
}

function roomSummary(room) {
  const last = room.messages[room.messages.length - 1];
  const participants = new Set(room.messages.map((message) => message.agent));
  return {
    id: room.id,
    name: room.name,
    topic: room.topic,
    createdAt: room.createdAt,
    pinned: room.pinned === true,
    pinnedMessage: pinnedMessageSummary(room),
    messageCount: room.messages.length,
    lastAt: last?.ts ?? null,
    lastPreview: last ? String(last.text).slice(0, 160) : '',
    participants: [...participants].slice(-30),
  };
}

function roomList() {
  return [...rooms.values()]
    .map(roomSummary)
    .sort((left, right) => Number(right.pinned) - Number(left.pinned));
}

function activeAgents() {
  const now = Date.now();
  const agents = [];
  for (const [agent, record] of presence) {
    if (now - record.lastSeen > PRESENCE_TTL_MS) continue;
    agents.push({ agent, role: record.role, color: record.color, lastSeen: new Date(record.lastSeen).toISOString(), online: true });
  }
  agents.sort((left, right) => left.agent.localeCompare(right.agent));
  return agents;
}

function touchPresence(agent, role, color) {
  const key = agent;
  const existing = presence.get(key);
  const record = {
    agent,
    role: role || existing?.role || '',
    color: color || existing?.color || colorFor(agent),
    firstSeen: existing?.firstSeen ?? Date.now(),
    lastSeen: Date.now(),
  };
  presence.set(key, record);
  broadcast('presence', { agent: record.agent, role: record.role, color: record.color, online: true, at: nowIso() });
  return record;
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of streamClients) {
    try {
      client.res.write(payload);
    } catch {
      streamClients.delete(client);
    }
  }
}

function broadcastToRoom(roomId, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of streamClients) {
    if (client.room !== null && client.room !== roomId) continue;
    try {
      client.res.write(payload);
    } catch {
      streamClients.delete(client);
    }
  }
}

function appendMessage(room, input) {
  const agent = sanitizeAgent(input.agent);
  if (agent === undefined) throw new HttpError(400, 'invalid agent name: use letters, digits, ".", "_" or "-" (max 40)');
  const text = String(input.text ?? '');
  if (text.length === 0) throw new HttpError(400, 'text is required');
  if (text.length > MAX_TEXT) throw new HttpError(413, `text is longer than ${MAX_TEXT} characters`);
  const kind = ['message', 'task', 'decision', 'system', 'note'].includes(input.kind) ? input.kind : 'message';
  const to = input.to === undefined || input.to === null || input.to === '' ? undefined : sanitizeAgent(input.to);
  const seq = room.seq + 1;
  const message = {
    id: randomUUID(),
    seq,
    room: room.id,
    agent,
    role: typeof input.role === 'string' ? input.role.slice(0, 60) : '',
    color: colorFor(agent),
    kind,
    ...(to !== undefined ? { to } : {}),
    text,
    ts: nowIso(),
    ...(input.replyTo !== undefined ? { replyTo: String(input.replyTo).slice(0, 80) } : {}),
    ...(input.meta !== undefined && input.meta !== null && typeof input.meta === 'object' ? { meta: input.meta } : {}),
  };
  room.messages.push(message);
  room.seq = seq;
  appendFileSync(roomFile(room.id), JSON.stringify(message) + '\n');
  touchPresence(agent, message.role, message.color);
  broadcastToRoom(room.id, 'message', message);
  return message;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, maxBytes = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, `upload is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeFileName(name) {
  const base = String(name ?? 'file').split(/[\\/]/u).pop() ?? 'file';
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/gu, '_').trim().slice(0, 140);
  return cleaned.length > 0 ? cleaned : 'file';
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2) + '\n';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-hub-token, authorization',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  });
  res.end(body);
}

function authorized(req, url) {
  if (TOKEN.length === 0) return true;
  const header = req.headers['x-hub-token'] ?? req.headers.authorization;
  const candidate = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : header;
  if (candidate === TOKEN) return true;
  return url.searchParams.get('token') === TOKEN;
}

function contentLengthOk(res, length) {
  res.writeHead(200, { 'content-length': length });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(url, res) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const resolved = normalize(join(PUBLIC_DIR, pathname));
  if (!resolved.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return false;
  const body = readFileSync(resolved);
  res.writeHead(200, {
    'content-type': MIME[extname(resolved)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
  return true;
}

function handleStream(req, res, url) {
  const roomId = url.searchParams.get('room');
  if (roomId !== null && !rooms.has(roomId)) throw new HttpError(404, `room "${roomId}" not found`);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 2000\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION, room: roomId, agents: activeAgents(), rooms: roomList() })}\n\n`);
  const client = { res, room: roomId };
  streamClients.add(client);
  const keepalive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepalive);
      streamClients.delete(client);
    }
  }, 25_000);
  req.on('close', () => {
    clearInterval(keepalive);
    streamClients.delete(client);
  });
}

async function handleApi(req, res, url, parts) {
  const [resource, id, sub] = parts;

  if (req.method === 'GET' && resource === 'health' && id === undefined) {
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      time: nowIso(),
      rooms: rooms.size,
      agents: activeAgents().length,
      streams: streamClients.size,
      workspace: WORKSPACE_DIR,
      tasks: tasks.length,
    });
    return;
  }

  if (req.method === 'GET' && resource === 'rooms' && id === undefined) {
    sendJson(res, 200, { rooms: roomList() });
    return;
  }

  if (req.method === 'POST' && resource === 'rooms' && id === undefined) {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    if (name.length === 0) throw new HttpError(400, 'name is required');
    const id = slugify(body.id ?? name);
    if (rooms.has(id)) {
      sendJson(res, 200, { room: roomSummary(rooms.get(id)), created: false });
      return;
    }
    const room = {
      id,
      name: name.slice(0, 80),
      topic: String(body.topic ?? '').slice(0, 1000),
      createdAt: nowIso(),
      pinned: false,
      pinnedMessageId: null,
      messages: [],
      seq: 0,
    };
    rooms.set(id, room);
    saveRoomsMeta();
    broadcast('rooms', { rooms: roomList() });
    sendJson(res, 201, { room: roomSummary(room), created: true });
    return;
  }

  if (req.method === 'POST' && resource === 'rooms' && id !== undefined && sub === 'pin') {
    const room = rooms.get(id);
    if (room === undefined) throw new HttpError(404, `room "${id}" not found`);
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    room.pinned = typeof body.pinned === 'boolean' ? body.pinned : room.pinned !== true;
    saveRoomsMeta();
    broadcast('rooms', { rooms: roomList() });
    sendJson(res, 200, { room: roomSummary(room), rooms: roomList() });
    return;
  }

  if (req.method === 'POST' && resource === 'rooms' && id !== undefined && sub === 'pin-message') {
    const room = rooms.get(id);
    if (room === undefined) throw new HttpError(404, `room "${id}" not found`);
    const body = await readBody(req);
    const messageId = String(body.messageId ?? '');
    if (messageId.length === 0) throw new HttpError(400, 'messageId is required');
    const message = room.messages.find((entry) => entry.id === messageId || String(entry.seq) === messageId);
    if (message === undefined) throw new HttpError(404, `message not found: ${messageId}`);
    room.pinnedMessageId = room.pinnedMessageId === message.id ? null : message.id;
    saveRoomsMeta();
    broadcast('rooms', { rooms: roomList() });
    sendJson(res, 200, { room: roomSummary(room), rooms: roomList() });
    return;
  }

  if (req.method === 'GET' && resource === 'rooms' && id !== undefined && sub === 'messages') {    const room = rooms.get(id);
    if (room === undefined) throw new HttpError(404, `room "${id}" not found`);
    const since = url.searchParams.get('since');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);
    const agentFilter = url.searchParams.get('agent');
    const toFilter = url.searchParams.get('to');
    let messages = room.messages;
    if (agentFilter) messages = messages.filter((message) => message.agent === agentFilter);
    if (toFilter) messages = messages.filter((message) => message.to === toFilter || (message.to === undefined && message.text.includes(`@${toFilter}`)));
    let startIndex = 0;
    if (since !== null && since !== '') {
      const sinceSeq = Number(since);
      startIndex = messages.findIndex((message) => message.seq > sinceSeq);
      if (startIndex === -1) startIndex = messages.length;
    } else {
      startIndex = Math.max(messages.length - limit, 0);
    }
    const page = messages.slice(startIndex, startIndex + limit);
    sendJson(res, 200, { room: roomSummary(room), messages: page, cursor: room.seq, from: since === null ? null : Number(since) });
    return;
  }

  if (req.method === 'POST' && resource === 'rooms' && id !== undefined && sub === 'messages') {
    const room = rooms.get(id);
    if (room === undefined) throw new HttpError(404, `room "${id}" not found`);
    const body = await readBody(req);
    const message = appendMessage(room, body);
    sendJson(res, 201, { message, cursor: room.seq });
    return;
  }

  if (req.method === 'DELETE' && resource === 'rooms' && id !== undefined && sub === undefined) {
    if (!rooms.has(id)) throw new HttpError(404, `room "${id}" not found`);
    rooms.delete(id);
    try {
      rmSync(roomFile(id), { force: true });
    } catch {
      /* the registry no longer references it */
    }
    if (rooms.size === 0) {
      rooms.set('general', { id: 'general', name: 'general', topic: 'Shared work space for every agent and the human.', createdAt: nowIso(), pinned: false, pinnedMessageId: null, messages: [], seq: 0 });
    }
    saveRoomsMeta();
    broadcast('rooms', { rooms: roomList() });
    sendJson(res, 200, { deleted: id, rooms: roomList() });
    return;
  }

  if (req.method === 'GET' && resource === 'switches' && id === undefined) {
    sendJson(res, 200, { switches: switchSnapshot() });
    return;
  }

  if (req.method === 'POST' && resource === 'switches' && id === undefined) {
    const body = await readBody(req);
    const agent = String(body.agent ?? '');
    if (!Object.hasOwn(DEFAULT_SWITCHES, agent)) {
      throw new HttpError(400, `agent must be one of: ${Object.keys(DEFAULT_SWITCHES).join(', ')}`);
    }
    switches[agent] = body.enabled === true;
    switches.updatedAt = nowIso();
    saveSwitches();
    broadcast('switches', { switches: switchSnapshot() });
    sendJson(res, 200, { switches: switchSnapshot() });
    return;
  }

  if (req.method === 'POST' && resource === 'rooms' && id !== undefined && sub === 'typing') {
    const room = rooms.get(id);
    if (room === undefined) throw new HttpError(404, `room "${id}" not found`);
    const body = await readBody(req);
    const agent = sanitizeAgent(body.agent);
    if (agent === undefined) throw new HttpError(400, 'valid agent name is required');
    const roomTyping = typing.get(room.id) ?? new Map();
    if (body.typing === true) roomTyping.set(agent, Date.now());
    else roomTyping.delete(agent);
    typing.set(room.id, roomTyping);
    broadcastToRoom(room.id, 'typing', {
      room: room.id,
      agent,
      typing: body.typing === true,
      ...(body.error === true ? { error: true } : {}),
      ...(typeof body.reason === 'string' && body.reason.length > 0 ? { reason: body.reason.slice(0, 240) } : {}),
      at: nowIso(),
    });
    sendJson(res, 200, { room: room.id, agent, typing: body.typing === true });
    return;
  }

  if (req.method === 'GET' && resource === 'settings' && id === undefined) {
    sendJson(res, 200, { settings: { ...settings } });
    return;
  }

  if (req.method === 'POST' && resource === 'settings' && id === undefined) {
    const body = await readBody(req);
    if (typeof body.fastReplies === 'boolean') settings.fastReplies = body.fastReplies;
    if (body.broadcastMode === 'all' || body.broadcastMode === 'single') settings.broadcastMode = body.broadcastMode;
    saveSettings();
    broadcast('settings', { settings: { ...settings } });
    sendJson(res, 200, { settings: { ...settings } });
    return;
  }

  if (req.method === 'GET' && resource === 'models' && id === undefined) {
    sendJson(res, 200, { models: modelSnapshot() });
    return;
  }

  if (req.method === 'POST' && resource === 'models' && id === undefined) {
    const body = await readBody(req);
    const agent = String(body.agent ?? '');
    if (!Object.hasOwn(DEFAULT_MODELS, agent)) {
      throw new HttpError(400, `agent must be one of: ${Object.keys(DEFAULT_MODELS).join(', ')}`);
    }
    if (typeof body.model === 'string') models[agent].model = body.model.trim().slice(0, 120);
    if (typeof body.fast === 'boolean') models[agent].fast = body.fast;
    saveModels();
    broadcast('models', { models: modelSnapshot() });
    sendJson(res, 200, { models: modelSnapshot() });
    return;
  }

  if (req.method === 'GET' && resource === 'workspace' && id === 'tree') {
    const relativePath = url.searchParams.get('path') ?? '';
    const absolute = resolveWorkspacePath(relativePath);
    if (!existsSync(absolute)) throw new HttpError(404, `workspace path not found: ${relativePath}`);
    const stat = statSync(absolute);
    if (!stat.isDirectory()) {
      sendJson(res, 200, { root: WORKSPACE_DIR, path: relativePath, entries: [] });
      return;
    }
    sendJson(res, 200, { root: WORKSPACE_DIR, path: relativePath, entries: workspaceEntries(absolute) });
    return;
  }

  if (req.method === 'GET' && resource === 'workspace' && id === 'file') {
    const relativePath = url.searchParams.get('path') ?? '';
    const absolute = resolveWorkspacePath(relativePath);
    if (!existsSync(absolute)) throw new HttpError(404, `file not found: ${relativePath}`);
    if (statSync(absolute).isDirectory()) throw new HttpError(400, 'path is a directory');
    const buffer = readFileSync(absolute);
    const text = buffer.toString('utf8');
    const binary = /\u0000/u.test(text);
    const MAX = 200_000;
    sendJson(res, 200, {
      path: relativePath,
      size: buffer.length,
      binary,
      content: binary ? null : text.slice(0, MAX),
      truncated: binary ? false : text.length > MAX,
    });
    return;
  }

  if (req.method === 'PUT' && resource === 'workspace' && id === 'file') {
    const body = await readBody(req);
    const relativePath = String(body.path ?? '');
    if (relativePath.length === 0) throw new HttpError(400, 'path is required');
    if (typeof body.content !== 'string') throw new HttpError(400, 'content must be a string');
    const absolute = resolveWorkspacePath(relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body.content);
    sendJson(res, 200, { path: relativePath, size: Buffer.byteLength(body.content) });
    return;
  }

  if (req.method === 'POST' && resource === 'workspace' && id === 'upload') {
    const fileName = safeFileName(url.searchParams.get('name'));
    const buffer = await readRawBody(req);
    if (buffer.length === 0) throw new HttpError(400, 'uploaded file is empty');
    const uploadDir = join(WORKSPACE_DIR, 'uploads');
    mkdirSync(uploadDir, { recursive: true });
    let stored;
    do {
      stored = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${fileName}`;
    } while (existsSync(join(uploadDir, stored)));
    writeFileSync(join(uploadDir, stored), buffer);
    const file = {
      name: fileName,
      path: `uploads/${stored}`,
      size: buffer.length,
      mtime: new Date().toISOString(),
    };
    broadcast('workspace', { upload: file });
    sendJson(res, 201, { file });
    return;
  }

  if (req.method === 'GET' && resource === 'workspace' && id === 'download') {
    const relativePath = url.searchParams.get('path') ?? '';
    const absolute = resolveWorkspacePath(relativePath);
    if (!existsSync(absolute)) throw new HttpError(404, `file not found: ${relativePath}`);
    if (statSync(absolute).isDirectory()) throw new HttpError(400, 'path is a directory');
    const buffer = readFileSync(absolute);
    const fileName = safeFileName(relativePath.split('/').pop());
    const inline = url.searchParams.get('inline') === '1';
    res.writeHead(200, {
      'content-type': MIME[extname(absolute)] ?? 'application/octet-stream',
      'content-length': buffer.length,
      ...(inline ? {} : { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}` }),
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(buffer);
    return;
  }

  if (req.method === 'GET' && resource === 'tasks' && id === undefined) {
    sendJson(res, 200, { tasks, workspace: WORKSPACE_DIR });
    return;
  }

  if (req.method === 'POST' && resource === 'tasks' && id === undefined) {
    const body = await readBody(req);
    const title = String(body.title ?? '').trim();
    if (title.length === 0) throw new HttpError(400, 'title is required');
    const assignee = String(body.assignee ?? '');
    if (!Object.hasOwn(DEFAULT_MODELS, assignee)) throw new HttpError(400, 'assignee must be claude, codex or dsh');
    const reviewer = body.reviewer === undefined || body.reviewer === '' ? null : String(body.reviewer);
    if (reviewer !== null && (!Object.hasOwn(DEFAULT_MODELS, reviewer) || reviewer === assignee)) {
      throw new HttpError(400, 'reviewer must be a different model (claude/codex/dsh)');
    }
    const roomId = String(body.room ?? 'general');
    if (!rooms.has(roomId)) throw new HttpError(404, `room "${roomId}" not found`);
    const task = {
      id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: title.slice(0, 200),
      description: String(body.description ?? '').slice(0, 4000),
      assignee,
      reviewer,
      room: roomId,
      status: 'open',
      createdBy: String(body.createdBy ?? 'human'),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    tasks.push(task);
    saveTasks();
    appendTaskMessage(task, assignee);
    broadcastTasks();
    sendJson(res, 201, { task });
    return;
  }

  if ((req.method === 'PATCH' || req.method === 'POST') && resource === 'tasks' && id !== undefined && sub === undefined) {
    const task = taskById(id);
    if (task === undefined) throw new HttpError(404, `task not found: ${id}`);
    const body = await readBody(req);
    if (typeof body.status === 'string') task.status = body.status.slice(0, 40);
    if (typeof body.assignee === 'string' && Object.hasOwn(DEFAULT_MODELS, body.assignee)) task.assignee = body.assignee;
    if (typeof body.reviewer === 'string' && Object.hasOwn(DEFAULT_MODELS, body.reviewer)) task.reviewer = body.reviewer;
    task.updatedAt = nowIso();
    saveTasks();
    broadcastTasks();
    sendJson(res, 200, { task });
    return;
  }

  if (req.method === 'POST' && resource === 'tasks' && id !== undefined && sub === 'review') {
    const task = taskById(id);
    if (task === undefined) throw new HttpError(404, `task not found: ${id}`);
    const body = await readBody(req);
    const reviewer = String(body.reviewer ?? '');
    if (!Object.hasOwn(DEFAULT_MODELS, reviewer)) throw new HttpError(400, 'reviewer must be claude, codex or dsh');
    if (reviewer === task.assignee) throw new HttpError(400, 'reviewer must differ from assignee');
    task.reviewer = reviewer;
    task.status = 'review';
    task.updatedAt = nowIso();
    saveTasks();
    appendTaskMessage(task, reviewer, 'review', String(body.note ?? '').slice(0, 2000));
    broadcastTasks();
    sendJson(res, 200, { task });
    return;
  }

  if (req.method === 'GET' && resource === 'agents' && id === undefined) {
    sendJson(res, 200, { agents: activeAgents(), ttlMs: PRESENCE_TTL_MS });
    return;
  }

  if (req.method === 'POST' && resource === 'agents' && id === 'presence') {
    const body = await readBody(req);
    const agent = sanitizeAgent(body.agent);
    if (agent === undefined) throw new HttpError(400, 'valid agent name is required');
    const record = touchPresence(agent, String(body.role ?? '').slice(0, 60), body.color);
    sendJson(res, 200, { agent: record.agent, role: record.role, color: record.color, online: true });
    return;
  }

  throw new HttpError(404, 'not found');
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-hub-token, authorization',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    });
    res.end();
    return;
  }

  if (!authorized(req, url)) {
    sendJson(res, 401, { error: 'unauthorized: set HUB_TOKEN and send it as x-hub-token or ?token=' });
    return;
  }

  if (url.pathname === '/api/stream') {
    try {
      handleStream(req, res, url);
    } catch (error) {
      sendJson(res, error.status ?? 500, { error: error.message });
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const parts = url.pathname.slice('/api/'.length).split('/').filter(Boolean).map(decodeURIComponent);
    handleApi(req, res, url, parts).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log('API error:', error);
      if (!res.headersSent) sendJson(res, status, { error: error.message });
      else res.end();
    });
    return;
  }

  if (req.method === 'GET' && serveStatic(url, res)) return;
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
});

loadState();

// Expire presence records so the dashboard does not show ghosts forever.
setInterval(() => {
  const now = Date.now();
  for (const [agent, record] of presence) {
    if (now - record.lastSeen > PRESENCE_TTL_MS) {
      presence.delete(agent);
      broadcast('presence', { agent, online: false, at: nowIso() });
      log(`presence expired: ${agent}`);
    }
  }
}, 30_000).unref?.();

server.listen(PORT, HOST, () => {
  log(`Agent Hub ${VERSION} listening on http://${HOST}:${PORT}`);
  log(`data directory: ${DATA_DIR}`);
  if (TOKEN.length > 0) log('HUB_TOKEN is set: agents must send it as x-hub-token or ?token=');
});
