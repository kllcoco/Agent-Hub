#!/usr/bin/env node
/**
 * Agent Hub worker daemon.
 *
 * Watches the hub and turns addressed messages into local model runs:
 *   - human messages that address a model (to=model, "@model" or its name in
 *     the text) get a conversational reply;
 *   - `kind=task` messages addressed to a model get task handling.
 *
 * Every model has a human-controlled switch. When a switch is OFF the worker
 * never starts that model's CLI, so nothing is spent; when it is ON the local
 * CLI (Codex, Claude Code, or DSH headless) is started and instructed to read
 * the hub and reply through the agent-hub MCP tools.
 *
 *   node worker.mjs                 # foreground daemon
 *   node worker.mjs --dry-run       # log what would run, never spawn a model
 *
 * Env overrides: WORKER_CODEX_CMD, WORKER_CLAUDE_CMD, WORKER_DSH_CMD,
 * WORKER_WORKDIR, WORKER_POLL_MS, WORKER_TIMEOUT_MS, HUB_URL, HUB_TOKEN.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BASE = String(process.env.HUB_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/u, '');
const TOKEN = process.env.HUB_TOKEN ?? '';
const DRY_RUN = process.argv.includes('--dry-run');
const POLL_MS = Math.max(500, Number(process.env.WORKER_POLL_MS ?? 750));
const TIMEOUT_MS = Math.max(30_000, Number(process.env.WORKER_TIMEOUT_MS ?? 300_000));
const CHAT_TIMEOUT_MS = Math.max(30_000, Number(process.env.WORKER_CHAT_TIMEOUT_MS ?? 120_000));
const WORKER_AGENT = 'worker';
const WORKDIR = process.env.WORKER_WORKDIR ?? join(ROOT, 'data', 'worker-workdir');
const STATE_FILE = join(ROOT, 'data', 'worker-state.json');
const DSH_PROMPT_FILE = join(ROOT, 'data', 'dsh-worker-prompt.txt');
const DSH_FAST_PATCH = join(ROOT, 'data', 'dsh-fast-patch.yml');
const DSH_PROVIDER = process.env.WORKER_DSH_PROVIDER ?? 'deepseek-official';
const DSH_MODEL = process.env.WORKER_DSH_MODEL ?? 'deepseek-flash';
const CLAUDE_MCP_CONFIG = join(ROOT, 'data', 'claude-worker-mcp.json');
const MCP_SCRIPT = join(ROOT, 'mcp.mjs');
const PID_FILE = join(ROOT, 'data', 'worker.pid');
const MAX_TAIL = 1800;

let fastReplies = true;
let broadcastMode = 'all';
let fastSettingSeen = false;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Single-instance guard: two workers would answer the same message twice.
try {
  const existing = Number(readFileSync(PID_FILE, 'utf8').trim());
  if (Number.isInteger(existing) && existing > 0 && existing !== process.pid && processAlive(existing)) {
    console.error(`worker: another instance is already running (pid ${existing})`);
    process.exit(1);
  }
} catch {
  /* no pid file */
}
writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => {
  try {
    if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE);
  } catch {
    /* best effort */
  }
});

const MODEL_META = {
  claude: { label: 'Claude', commandEnv: 'WORKER_CLAUDE_CMD', aliases: ['claude'] },
  codex: { label: 'GPT / Codex', commandEnv: 'WORKER_CODEX_CMD', aliases: ['codex', 'gpt', 'chatgpt', 'openai'] },
  dsh: { label: 'DSH', commandEnv: 'WORKER_DSH_CMD', aliases: ['dsh', 'deepseek'] },
};
const MODELS = Object.keys(MODEL_META);

mkdirSync(WORKDIR, { recursive: true });

const nowIso = () => new Date().toISOString();
const log = (...args) => console.log(`[${nowIso()}]`, ...args);

function loadState() {
  try {
    const value = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { rooms: value.rooms ?? {}, handled: Array.isArray(value.handled) ? value.handled : [] };
  } catch {
    return { rooms: {}, handled: [] };
  }
}
const state = loadState();
function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify({ rooms: state.rooms, handled: state.handled.slice(-500) }, null, 2) + '\n');
}

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (TOKEN) headers['x-hub-token'] = TOKEN;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, { ...options, headers });
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = { error: text };
  }
  if (!response.ok) throw new Error(`${response.status} ${value.error ?? text}`);
  return value;
}

/* ------------------------------------------------------------------ */
/* local CLI discovery                                                 */
/* ------------------------------------------------------------------ */

function findOnPath(names) {
  const pathEntries = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  for (const name of names) {
    for (const entry of pathEntries) {
      if (!entry) continue;
      for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
        const candidate = join(entry, name + ext);
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      }
    }
  }
  return undefined;
}

function newest(paths) {
  return paths
    .filter((path) => existsSync(path))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)[0]?.path;
}

function findClaude() {
  if (process.env.WORKER_CLAUDE_CMD) return process.env.WORKER_CLAUDE_CMD;
  const onPath = findOnPath(['claude']);
  if (onPath) return onPath;
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const candidates = [];
  const collect = (base) => {
    if (!existsSync(base)) return;
    for (const version of readdirSync(base, { withFileTypes: true })) {
      if (!version.isDirectory()) continue;
      const versionDir = join(base, version.name);
      for (const build of readdirSync(versionDir, { withFileTypes: true })) {
        if (build.isDirectory()) candidates.push(join(versionDir, build.name, 'claude.exe'));
      }
    }
  };
  // New Claude Desktop layout: %LOCALAPPDATA%\Claude-Data\<package>\claude-code\<version>\<build>\claude.exe
  const claudeData = join(localAppData, 'Claude-Data');
  if (existsSync(claudeData)) {
    for (const entry of readdirSync(claudeData, { withFileTypes: true })) {
      if (entry.isDirectory()) collect(join(claudeData, entry.name, 'claude-code'));
    }
  }
  // Legacy MSIX layout: %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code\...
  const packagesDir = join(localAppData, 'Packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('Claude_')) {
        collect(join(packagesDir, entry.name, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
      }
    }
  }
  return newest(candidates);
}

function findCodex() {
  if (process.env.WORKER_CODEX_CMD) return process.env.WORKER_CODEX_CMD;
  const onPath = findOnPath(['codex']);
  if (onPath) return onPath;
  const base = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  if (!existsSync(base)) return undefined;
  const candidates = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(join(base, entry.name, 'codex.exe'));
  }
  return newest(candidates);
}

function findDsh() {
  if (process.env.WORKER_DSH_CMD) return process.env.WORKER_DSH_CMD;
  const onPath = findOnPath(['dsh']);
  if (onPath) return onPath;
  const candidates = [
    join(homedir(), '.dsh', 'bin', 'dsh.cmd'),
  ];
  return candidates.find((path) => existsSync(path));
}

const COMMANDS = { claude: findClaude(), codex: findCodex(), dsh: findDsh() };

let cachedKey;
function deepSeekKey() {
  if (cachedKey !== undefined) return cachedKey;
  cachedKey = null;
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const match = /^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/mu.exec(text);
    if (match !== null) cachedKey = match[1];
  } catch {
    /* no credentials file */
  }
  return cachedKey;
}

/* ------------------------------------------------------------------ */
/* prompts & runs                                                      */
/* ------------------------------------------------------------------ */

let WORKSPACE_ROOT = join(ROOT, 'workspace');

function contextLines(message) {
  const list = Array.isArray(message.context) ? message.context : [];
  return list.map((entry) => `#${entry.seq} ${entry.agent}${entry.to ? ` -> @${entry.to}` : ''}: ${String(entry.text).replace(/\s+/gu, ' ').slice(0, 260)}`);
}

function attachmentLines(message) {
  const list = Array.isArray(message.meta?.attachments) ? message.meta.attachments : [];
  if (list.length === 0) return [];
  return [
    'Attached files (already saved in the shared workspace):',
    ...list.map((entry) => `- ${entry.path} (${entry.name ?? 'file'}, ${entry.size ?? '?'} bytes)`),
    '',
  ];
}

function buildTaskPrompt(model, roomId, message) {
  const label = MODEL_META[model].label;
  const review = message.meta?.review === true;
  return [
    `You are ${label}, a colleague in the Agent Hub shared workspace.`,
    `Shared workspace directory: ${WORKSPACE_ROOT}`,
    `You are working on ${review ? 'a REVIEW of' : 'the task'} message #${message.seq} in room "${roomId}" (from ${message.agent}).`,
    ...attachmentLines(message),
    ...(contextLines(message).length > 0 ? ['Recent team messages:', ...contextLines(message), ''] : []),
    'Rules:',
    '1. Read the hub context and the relevant files in the shared workspace before editing (use your file/shell tools).',
    '2. Other models work in the same directory. Re-read files before editing; if another model is wrong, point it out and fix it directly.',
    '3. Work only inside the shared workspace directory; keep changes focused on the task.',
    '4. When done, call hub_send to room "' + roomId + '" with kind "decision", to "human", replyTo "' + message.id + '", listing files changed, disagreements with other models, and open questions.',
    `Task text:\n${message.text}`,
  ].join('\n');
}

function buildChatPrompt(model, roomId, message) {
  const label = MODEL_META[model].label;
  return [
    `You are ${label}, a colleague in the Agent Hub room "${roomId}".`,
    `Shared workspace directory: ${WORKSPACE_ROOT}`,
    ...attachmentLines(message),
    ...(contextLines(message).length > 0 ? ['Recent team messages:', ...contextLines(message), ''] : []),
    `The human wrote message #${message.seq}: "${message.text}"`,
    `Reply directly with hub_send to room "${roomId}", kind "message", to "human", replyTo "${message.id}".`,
    'If you notice a wrong claim or bad code from another model in the recent messages, point it out briefly and give the correction.',
    'Do not call hub_read or other tools for this short reply. Be concise (1-3 sentences), in the human\'s language.',
  ].join('\n');
}

function cliArgs(model, prompt) {
  if (model === 'codex') {
    const args = ['exec', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '--json'];
    if (fastReplies) args.push('-c', 'model_reasoning_effort="low"', '-c', 'model_reasoning_summary="none"');
    args.push(prompt);
    return args;
  }
  const args = [
    '-p', prompt,
    '--output-format', 'text',
    '--permission-mode', 'acceptEdits',
    '--strict-mcp-config',
    '--mcp-config', CLAUDE_MCP_CONFIG,
    '--allowedTools',
    'mcp__agent-hub__hub_read', 'mcp__agent-hub__hub_send', 'mcp__agent-hub__hub_join', 'mcp__agent-hub__hub_switches',
    'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  ];
  if (fastReplies) args.push('--effort', 'low');
  return args;
}

function writeClaudeMcpConfig() {
  const config = {
    mcpServers: {
      'agent-hub': {
        command: process.execPath,
        args: [MCP_SCRIPT, '--agent', 'claude', '--url', BASE],
      },
    },
  };
  writeFileSync(CLAUDE_MCP_CONFIG, JSON.stringify(config, null, 2) + '\n');
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? WORKDIR,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, timedOut: true, stdout, stderr });
    }, options.timeoutMs ?? TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ code: -1, timedOut: false, stdout, stderr: `${stderr}\n${error.message}` }));
    child.on('close', (code) => finish({ code, timedOut: false, stdout, stderr }));
  });
}

function runModel(model, prompt, timeoutMs = TIMEOUT_MS) {
  if (model === 'dsh') {
    if (deepSeekKey() === null) {
      return Promise.resolve({ code: -1, timedOut: false, stdout: '', stderr: 'DEEPSEEK_API_KEY not found in ~/.dsh/.credentials.yaml' });
    }
    writeFileSync(DSH_PROMPT_FILE, prompt, 'utf8');
    const patchArgs = [];
    if (fastReplies) {
      writeFileSync(DSH_FAST_PATCH, [
        '- id: agent-default-model',
        '  config:',
        `    provider: ${JSON.stringify(DSH_PROVIDER)}`,
        `    model: ${JSON.stringify(DSH_MODEL)}`,
        '    reasoningEffort: "low"',
        '',
      ].join('\n'), 'utf8');
      patchArgs.push('--patch', `"${DSH_FAST_PATCH}"`);
    }
    const script = [
      `$p = Get-Content -Raw -LiteralPath '${DSH_PROMPT_FILE.replaceAll("'", "''")}'`,
      `& '${COMMANDS.dsh.replaceAll("'", "''")}' --profile headless ${patchArgs.join(' ')} $p`,
    ].join('; ');
    return runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { DEEPSEEK_API_KEY: deepSeekKey(), DSH_PERMISSION_MODE: 'danger-full-access' },
      cwd: WORKSPACE_ROOT,
      timeoutMs,
    });
  }
  return runProcess(COMMANDS[model], cliArgs(model, prompt), { cwd: WORKSPACE_ROOT, timeoutMs });
}

/* ------------------------------------------------------------------ */
/* hub helpers                                                         */
/* ------------------------------------------------------------------ */

async function postSystem(text, kind = 'system', roomId = 'general') {
  try {
    await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ agent: WORKER_AGENT, role: 'worker daemon', kind, text }),
    });
  } catch (error) {
    log(`could not post system message: ${error.message}`);
  }
}

async function setTyping(roomId, agent, typing, extra = {}) {
  try {
    await api(`/api/rooms/${encodeURIComponent(roomId)}/typing`, {
      method: 'POST',
      body: JSON.stringify({ agent, typing, ...extra }),
    });
  } catch {
    /* typing is cosmetic */
  }
}

async function patchTask(taskId, patch) {
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  } catch (error) {
    log(`task ${taskId} update failed: ${error.message}`);
  }
}

function targetsOf(message) {
  const targets = new Set();
  if (typeof message.to === 'string' && Object.hasOwn(MODEL_META, message.to)) targets.add(message.to);
  const text = String(message.text ?? '').toLowerCase();
  for (const model of MODELS) {
    for (const alias of MODEL_META[model].aliases) {
      if (new RegExp(`(^|[^a-z0-9])@?${alias}([^a-z0-9]|$)`, 'u').test(text)) {
        targets.add(model);
        break;
      }
    }
  }
  return [...targets];
}

const running = new Set();
const queues = { claude: [], codex: [], dsh: [] };

async function enqueueWork(model, roomId, message, mode) {
  state.handled.push(message.id);
  saveState();
  queues[model].push({ roomId, message, mode });
  if (running.has(model)) return;
  running.add(model);
  try {
    while (queues[model].length > 0) {
      const next = queues[model].shift();
      await handleWork(model, next.roomId, next.message, next.mode);
    }
  } finally {
    running.delete(model);
  }
}

async function handleWork(model, roomId, message, mode) {
  const label = MODEL_META[model].label;
  const command = COMMANDS[model];
  const taskId = typeof message.meta?.taskId === 'string' ? message.meta.taskId : null;
  let typingHeartbeat = null;
  try {
    log(`${mode} #${message.seq} (${roomId}) -> ${model}`);
    if (DRY_RUN) {
      await postSystem(`dry-run：收到 ${label} 的${mode === 'task' ? '任务' : '消息'} #${message.seq}，模拟执行（未调用模型）。`, 'note', roomId);
      return;
    }
    if (!command) {
      await postSystem(`worker：找不到 ${label} 的本地 CLI，${mode === 'task' ? '任务' : '回复'} #${message.seq} 未执行。设置 ${MODEL_META[model].commandEnv} 可指定路径。`, 'system', roomId);
      return;
    }
    if (taskId) await patchTask(taskId, { status: 'in_progress' });
    await setTyping(roomId, model, true);
    typingHeartbeat = setInterval(() => { void setTyping(roomId, model, true); }, 10_000);
    const prompt = mode === 'task' ? buildTaskPrompt(model, roomId, message) : buildChatPrompt(model, roomId, message);
    const result = await runModel(model, prompt, mode === 'chat' ? CHAT_TIMEOUT_MS : TIMEOUT_MS);
    const replied = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages?since=${message.seq}&limit=100`)
      .then((data) => data.messages.some((entry) => entry.agent === model))
      .catch(() => false);
    if (replied) {
      if (taskId) await patchTask(taskId, { status: message.meta?.review === true ? 'done' : 'review' });
      log(`${mode} #${message.seq} handled by ${model}`);
      return;
    }
    if (taskId) await patchTask(taskId, { status: 'open' });
    const tail = `${result.stdout}\n${result.stderr}`.trim().slice(-MAX_TAIL);
    const reasons = [];
    if (result.timedOut) reasons.push(`超时（${Math.round(TIMEOUT_MS / 1000)}s）`);
    else if (result.code !== 0) reasons.push(`退出码 ${result.code}`);
    if (/not logged in|please run \/login/iu.test(tail)) reasons.push('未登录（先运行 claude 并 /login）');
    if (/apply deny-read ACLs|sandbox failed/iu.test(tail)) reasons.push('沙箱 ACL 失败');
    if (/DEEPSEEK_API_KEY not found/iu.test(tail)) reasons.push('缺少 DEEPSEEK_API_KEY（~/.dsh/.credentials.yaml）');
    await setTyping(roomId, model, false, { error: true, reason: reasons.join('；') || '未在 hub 回帖' });
    await postSystem(
      `worker：${label} 处理${mode === 'task' ? '任务' : '回复'} #${message.seq} 失败${reasons.length > 0 ? `（${reasons.join('；')}）` : '（运行结束但未在 hub 回帖）'}。\n命令：${command}\n输出尾部：\n${tail || '(empty)'}`,
      'system',
      roomId,
    );
    log(`${mode} #${message.seq} failed: ${reasons.join('; ') || 'no reply'}`);
  } catch (error) {
    if (taskId) await patchTask(taskId, { status: 'open' });
    log(`${mode} #${message.seq} threw: ${error.message}`);
    await postSystem(`worker：处理 #${message.seq} 时异常：${error.message}`, 'system', roomId);
  } finally {
    if (typingHeartbeat !== null) clearInterval(typingHeartbeat);
    await setTyping(roomId, model, false);
  }
}

async function tick() {
  const { switches } = await api('/api/switches');
  const settingsData = await api('/api/settings').catch(() => ({ settings: { fastReplies, broadcastMode } }));
  fastReplies = settingsData.settings?.fastReplies !== false;
  broadcastMode = settingsData.settings?.broadcastMode === 'single' ? 'single' : 'all';
  if (!fastSettingSeen) {
    fastSettingSeen = true;
    log(`reply speed: ${fastReplies ? 'fast / low reasoning' : 'harness default reasoning'}; broadcast: ${broadcastMode}`);
  }
  const { rooms } = await api('/api/rooms');
  for (const room of rooms) {
    const roomState = state.rooms[room.id] ?? (state.rooms[room.id] = { lastSeq: room.messageCount });
    if (!Number.isInteger(roomState.lastSeq)) roomState.lastSeq = room.messageCount;
    const data = await api(`/api/rooms/${encodeURIComponent(room.id)}/messages?since=${roomState.lastSeq}&limit=100`);
    roomState.lastSeq = data.cursor ?? roomState.lastSeq;
    const recent = await api(`/api/rooms/${encodeURIComponent(room.id)}/messages?limit=40`).catch(() => ({ messages: [] }));
    for (const message of data.messages) {
      if (state.handled.includes(message.id)) continue;
      message.context = (recent.messages ?? []).filter((entry) => entry.seq < message.seq).slice(-8);
      let targets = [];
      let mode;
      if (message.kind === 'task') {
        if (typeof message.to !== 'string' || !Object.hasOwn(MODEL_META, message.to)) continue;
        targets = [message.to];
        mode = 'task';
      } else {
        if (message.agent !== 'human') continue;
        targets = targetsOf(message);
        mode = 'chat';
        if (targets.length === 0 && (message.to === undefined || message.to === null || message.to === '')) {
          // No explicit role and no @mention: broadcast according to the hub setting.
          if (broadcastMode === 'single') {
            const preferred = ['dsh', 'codex', 'claude'].find((model) => switches[model] === true);
            targets = preferred === undefined ? [] : [preferred];
          } else {
            targets = MODELS;
          }
        }
        if (targets.length === 0) continue;
      }
      targets = targets.filter((target) => message.agent !== target);
      if (targets.length === 0) continue;
      const enabled = targets.filter((target) => switches[target] === true);
      const disabled = targets.filter((target) => switches[target] !== true);
      if (mode === 'task') {
        for (const target of disabled) log(`skip task #${message.seq}: ${target} switch is off`);
      }
      if (enabled.length === 0) {
        state.handled.push(message.id);
        saveState();
        continue;
      }
      state.handled.push(message.id);
      saveState();
      for (const target of enabled) void enqueueWork(target, room.id, message, mode);
    }
    saveState();
  }
}

async function heartbeat() {
  try {
    await api('/api/agents/presence', { method: 'POST', body: JSON.stringify({ agent: WORKER_AGENT, role: 'worker daemon' }) });
  } catch {
    /* hub may be down */
  }
}

async function main() {
  log(`Agent Hub worker daemon · hub ${BASE}`);
  log('auto-reply: human messages that address a model; tasks: kind=task with to=<model>');
  writeClaudeMcpConfig();
  try {
    const health = await api('/api/health');
    if (typeof health.workspace === 'string') WORKSPACE_ROOT = health.workspace;
  } catch {
    /* keep default workspace path */
  }
  log(`shared workspace: ${WORKSPACE_ROOT}`);
  for (const [model, command] of Object.entries(COMMANDS)) log(`${model}: ${command ?? 'CLI not found'}`);
  if (DRY_RUN) log('dry-run: messages are acknowledged, models are not started');
  await heartbeat();
  setInterval(() => { heartbeat().catch(() => {}); }, 50_000).unref?.();
  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    log('stopping');
    process.exit(0);
  });
  while (!stopped) {
    try {
      await tick();
    } catch (error) {
      log(`tick failed: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

main().catch((error) => {
  console.error(`worker failed: ${error.stack ?? error.message}`);
  process.exit(1);
});
