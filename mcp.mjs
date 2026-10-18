#!/usr/bin/env node
/**
 * Agent Hub MCP server (stdio transport).
 *
 * Makes the shared space available to MCP-capable harnesses (Claude Code,
 * Codex CLI, DSH through an mcp-client row, or anything else that speaks MCP).
 *
 *   node mcp.mjs --agent claude --url http://127.0.0.1:8787
 *
 * Tools: hub_join, hub_rooms, hub_agents, hub_send, hub_read, hub_wait.
 * stdout carries JSON-RPC only; diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] !== undefined) return argv[index + 1];
  return fallback;
}
const AGENT = argValue('agent', process.env.HUB_AGENT ?? 'mcp-agent');
const ROLE = argValue('role', process.env.HUB_AGENT_ROLE ?? '');
const BASE = String(argValue('url', process.env.HUB_URL ?? 'http://127.0.0.1:8787')).replace(/\/+$/u, '');
const TOKEN = String(argValue('token', process.env.HUB_TOKEN ?? ''));
const VERSION = '1.0.0';

/**
 * Automatic onboarding: delivered through MCP `instructions` and the hub_join
 * result, so every model sees the rules without a visible chat message.
 */
const ONBOARDING = [
  'Agent Hub onboarding (automatic, no chat message needed):',
  '- You are in a shared team space with Claude, GPT/Codex, DSH and the human.',
  '- Call hub_join once at the start; read context with hub_read and follow up with hub_wait.',
  '- Use hub_send: kind=task to assign work, kind=decision for conclusions, kind=note for context.',
  '- Address someone with the "to" field or @name; keep messages concise.',
  '- All models share the same workspace directory; read files before editing, and point out/fix mistakes from other models.',
  '- Files uploaded in the web UI are saved under workspace/uploads and their paths are included in the message.',
  '- Only the human controls the model switches; never assume another model will answer when its switch is off.',
].join('\n');

const log = (...args) => process.stderr.write(`[agent-hub-mcp] ${args.join(' ')}\n`);

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

async function joinHub(role = ROLE) {
  return api('/api/agents/presence', {
    method: 'POST',
    body: JSON.stringify({ agent: AGENT, role }),
  });
}

/** Keep the presence record fresh while this MCP server process lives. */
let heartbeat;
function startHeartbeat() {
  if (heartbeat !== undefined) return;
  heartbeat = setInterval(() => {
    joinHub().catch((error) => log(`heartbeat failed: ${error.message}`));
  }, 55_000);
  heartbeat.unref?.();
}

function textResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

const TOOLS = [
  {
    name: 'hub_join',
    description: `Join the Agent Hub as "${AGENT}" and mark yourself online. Call once at the start of a session.`,
    inputSchema: {
      type: 'object',
      properties: { role: { type: 'string', description: 'Human-readable role, e.g. "Claude Code" or "Codex".' } },
    },
  },
  {
    name: 'hub_rooms',
    description: 'List coordination rooms with message counts, topics and participants.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hub_agents',
    description: 'List agents currently online in the hub.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hub_send',
    description: 'Post a message to a room. Use kind=task for work items, decision for agreed conclusions, note for context. Set to to address one agent directly.',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Room id (default "general").' },
        text: { type: 'string', description: 'Message body (plain text or light markdown).' },
        to: { type: 'string', description: 'Optional agent name to address directly.' },
        replyTo: { type: 'string', description: 'Optional message id or seq to quote.' },
        kind: { type: 'string', enum: ['message', 'task', 'decision', 'note', 'system'], description: 'Message kind (default message).' },
      },
      required: ['room', 'text'],
    },
  },
  {
    name: 'hub_read',
    description: 'Read recent messages from a room. Use since with the returned cursor to fetch only new messages.',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Room id.' },
        since: { type: 'integer', description: 'Only messages with seq > since.' },
        limit: { type: 'integer', description: 'Maximum messages (default 50, max 500).' },
        from: { type: 'string', description: 'Only messages from this agent.' },
        to: { type: 'string', description: 'Only messages addressed to this agent (or mentioning it).' },
      },
      required: ['room'],
    },
  },
  {
    name: 'hub_switches',
    description: 'Read the human-controlled per-model invocation switches (claude/codex/dsh). Read-only: only the human can toggle them in the dashboard; when a switch is off, do not assign work that requires invoking that model.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hub_wait',
    description: 'Wait for new messages in a room (polling). Returns immediately when a message arrives or the timeout elapses; use it between turns so other agents can reply.',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Room id.' },
        since: { type: 'integer', description: 'Cursor to wait after (default 0).' },
        timeoutMs: { type: 'integer', description: 'Maximum wait in milliseconds (default 60000, max 240000).' },
        from: { type: 'string', description: 'Only wake for messages from this agent.' },
        to: { type: 'string', description: 'Only wake for messages addressed to this agent.' },
      },
      required: ['room'],
    },
  },
];

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function callTool(name, args) {
  switch (name) {
    case 'hub_join': {
      const role = typeof args.role === 'string' && args.role.length > 0 ? args.role : ROLE;
      const presence = await joinHub(role);
      return textResult({ joined: presence.agent, role: presence.role, online: true, hub: BASE, onboarding: ONBOARDING });
    }
    case 'hub_rooms': {
      const { rooms } = await api('/api/rooms');
      return textResult({ rooms });
    }
    case 'hub_agents': {
      const { agents } = await api('/api/agents');
      return textResult({ agents });
    }
    case 'hub_switches': {
      const { switches } = await api('/api/switches');
      return textResult({ switches });
    }
    case 'hub_send': {
      const room = typeof args.room === 'string' && args.room.length > 0 ? args.room : 'general';
      const body = { agent: AGENT, text: String(args.text ?? ''), kind: typeof args.kind === 'string' ? args.kind : 'message' };
      if (typeof args.to === 'string' && args.to.length > 0) body.to = args.to;
      if (typeof args.replyTo === 'string' && args.replyTo.length > 0) body.replyTo = args.replyTo;
      if (ROLE.length > 0) body.role = ROLE;
      const data = await api(`/api/rooms/${encodeURIComponent(room)}/messages`, { method: 'POST', body: JSON.stringify(body) });
      return textResult({ sent: true, room, seq: data.message.seq, cursor: data.cursor, id: data.message.id });
    }
    case 'hub_read': {
      const room = String(args.room ?? 'general');
      const params = new URLSearchParams();
      if (args.since !== undefined) params.set('since', String(args.since));
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (typeof args.from === 'string') params.set('agent', args.from);
      if (typeof args.to === 'string') params.set('to', args.to);
      const data = await api(`/api/rooms/${encodeURIComponent(room)}/messages?${params}`);
      return textResult({ room, cursor: data.cursor, count: data.messages.length, messages: data.messages });
    }
    case 'hub_wait': {
      const room = String(args.room ?? 'general');
      const since = Number.isInteger(args.since) ? args.since : Number(args.since ?? 0) || 0;
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 60_000) || 60_000, 500), 240_000);
      const deadline = Date.now() + timeoutMs;
      let cursor = since;
      while (Date.now() < deadline) {
        const params = new URLSearchParams({ since: String(cursor), limit: '100' });
        if (typeof args.from === 'string') params.set('agent', args.from);
        if (typeof args.to === 'string') params.set('to', args.to);
        const data = await api(`/api/rooms/${encodeURIComponent(room)}/messages?${params}`);
        cursor = Math.max(cursor, data.cursor ?? 0);
        if (data.messages.length > 0) return textResult({ room, cursor, messages: data.messages });
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      return textResult({ room, cursor, messages: [], timedOut: true, hint: 'No new messages. Use hub_read to inspect history or hub_send to continue.' });
    }
    case 'hub_health': {
      return textResult(await api('/api/health'));
    }
    default:
      return textResult(`unknown tool "${name}"`, true);
  }
}

async function handleRequest(message) {
  const { id, method, params } = message;
  const hasId = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        joinHub().then(startHeartbeat).catch((error) => log(`presence registration failed: ${error.message}`));
        respond(id, {
          protocolVersion: typeof requested === 'string' ? requested : '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agent-hub', version: VERSION },
          instructions: `You are connected to the Agent Hub as "${AGENT}". Call hub_join once, then use hub_read/hub_wait to follow the conversation and hub_send to reply. Address agents with @name or the "to" field; mark conclusions as kind=decision and work items as kind=task.\n\n${ONBOARDING}`,
        });
        return;
      }
      case 'notifications/initialized':
      case 'initialized':
        return;
      case 'ping':
        if (hasId) respond(id, {});
        return;
      case 'tools/list':
        respond(id, { tools: TOOLS });
        return;
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments ?? {};
        try {
          const result = await callTool(name, args);
          respond(id, result);
        } catch (error) {
          respond(id, textResult(`hub error: ${error.message}`, true));
        }
        return;
      }
      case 'resources/list':
        respond(id, { resources: [] });
        return;
      case 'prompts/list':
        respond(id, { prompts: [] });
        return;
      case 'logging/setLevel':
        if (hasId) respond(id, {});
        return;
      case 'shutdown':
        if (hasId) respond(id, {});
        return;
      case 'exit':
        process.exit(0);
        return;
      default:
        if (hasId) respondError(id, -32601, `method not found: ${method}`);
    }
  } catch (error) {
    if (hasId) respondError(id, -32603, error.message);
    else log(`notification error: ${error.message}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    log(`invalid JSON-RPC line: ${error.message}`);
    return;
  }
  if (Array.isArray(message)) {
    for (const entry of message) handleRequest(entry);
    return;
  }
  handleRequest(message);
});
rl.on('close', () => process.exit(0));

log(`ready as "${AGENT}" -> ${BASE}`);
