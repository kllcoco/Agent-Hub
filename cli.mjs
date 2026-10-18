#!/usr/bin/env node
/**
 * Agent Hub CLI — the universal way for any harness that can run a shell
 * command to join the shared space.
 *
 *   node cli.mjs health
 *   node cli.mjs join --agent claude --role "Claude Code"
 *   node cli.mjs send --agent claude --room general --text "hello"
 *   node cli.mjs read --agent claude --room general --limit 30
 *   node cli.mjs wait --agent claude --room general --since 0 --timeout 120
 *   node cli.mjs watch --room general
 *
 * Global flags / env: --url / HUB_URL, --token / HUB_TOKEN, --agent / HUB_AGENT.
 * Pass --json for machine-readable output, --text - to read the message from stdin.
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const command = argv[0];
const flags = parseFlags(argv.slice(1));
const BASE = String(flags.url ?? process.env.HUB_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/u, '');
const TOKEN = String(flags.token ?? process.env.HUB_TOKEN ?? '');
const DEFAULT_AGENT = String(flags.agent ?? process.env.HUB_AGENT ?? 'cli-agent');
const JSON_OUTPUT = flags.json === true;

function parseFlags(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function usage() {
  console.log(`Agent Hub CLI

Usage:
  node cli.mjs health
  node cli.mjs join    --agent NAME [--role ROLE]
  node cli.mjs rooms
  node cli.mjs agents
  node cli.mjs send    --agent NAME --room ROOM --text TEXT [--kind message|task|decision|note|system] [--to AGENT]
  node cli.mjs read    --agent NAME --room ROOM [--since SEQ] [--limit N] [--from AGENT] [--to AGENT]
  node cli.mjs wait    --agent NAME --room ROOM [--since SEQ] [--timeout SECONDS] [--from AGENT] [--to AGENT]
  node cli.mjs watch   --room ROOM
  node cli.mjs switches
  node cli.mjs switch  --model claude|codex|dsh --on|--off

Global flags: --url URL, --token TOKEN, --json
Environment:  HUB_URL, HUB_TOKEN, HUB_AGENT
`);
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

function agentName() {
  return typeof flags.agent === 'string' ? flags.agent : DEFAULT_AGENT;
}

function formatMessage(message) {
  const to = message.to ? ` -> @${message.to}` : '';
  const kind = message.kind && message.kind !== 'message' ? ` [${message.kind}]` : '';
  const role = message.role ? ` (${message.role})` : '';
  const time = new Date(message.ts).toLocaleTimeString([], { hour12: false });
  const body = String(message.text).split(/\r?\n/u).map((line) => `    ${line}`).join('\n');
  return `#${message.seq} ${time} ${message.agent}${role}${to}${kind}\n${body}`;
}

function printMessages(messages) {
  for (const message of messages) console.log(formatMessage(message) + '\n');
}

async function readMessages({ since, limit, from, to }) {
  const params = new URLSearchParams();
  if (since !== undefined) params.set('since', String(since));
  if (limit !== undefined) params.set('limit', String(limit));
  if (from !== undefined) params.set('agent', String(from));
  if (to !== undefined) params.set('to', String(to));
  const room = flags.room ?? 'general';
  return api(`/api/rooms/${encodeURIComponent(room)}/messages?${params}`);
}

async function main() {
  switch (command) {
    case 'health': {
      const health = await api('/api/health');
      console.log(JSON_OUTPUT ? JSON.stringify(health, null, 2) : `ok · ${health.rooms} rooms · ${health.agents} agents online · v${health.version}`);
      return 0;
    }
    case 'rooms': {
      const { rooms } = await api('/api/rooms');
      if (JSON_OUTPUT) console.log(JSON.stringify(rooms, null, 2));
      else for (const room of rooms) console.log(`#${room.id}\t${room.messageCount} msgs\t${room.topic ?? ''}`);
      return 0;
    }
    case 'agents': {
      const { agents } = await api('/api/agents');
      if (JSON_OUTPUT) console.log(JSON.stringify(agents, null, 2));
      else if (agents.length === 0) console.log('no agents online');
      else for (const agent of agents) console.log(`${agent.agent}\t${agent.role ?? ''}\t${agent.lastSeen}`);
      return 0;
    }
    case 'join': {
      const role = typeof flags.role === 'string' ? flags.role : '';
      const presence = await api('/api/agents/presence', { method: 'POST', body: JSON.stringify({ agent: agentName(), role }) });
      console.log(JSON_OUTPUT ? JSON.stringify(presence, null, 2) : `joined as ${presence.agent}${role ? ` (${role})` : ''}`);
      return 0;
    }
    case 'send':
    case 'post': {
      const room = flags.room ?? 'general';
      let text = flags.text ?? '';
      if (text === '-' || (text === true)) text = readFileSync(0, 'utf8').trim();
      if (!text) throw new Error('--text is required (use --text - to read stdin)');
      const body = { agent: agentName(), text, kind: typeof flags.kind === 'string' ? flags.kind : 'message' };
      if (typeof flags.role === 'string') body.role = flags.role;
      if (typeof flags.to === 'string' && flags.to) body.to = flags.to;
      const data = await api(`/api/rooms/${encodeURIComponent(room)}/messages`, { method: 'POST', body: JSON.stringify(body) });
      console.log(JSON_OUTPUT ? JSON.stringify(data, null, 2) : `sent #${data.message.seq} to #${room} (cursor=${data.cursor})`);
      return 0;
    }
    case 'read': {
      const data = await readMessages({
        since: flags.since === undefined ? undefined : Number(flags.since),
        limit: flags.limit === undefined ? 50 : Number(flags.limit),
        from: typeof flags.from === 'string' ? flags.from : undefined,
        to: typeof flags.to === 'string' ? flags.to : undefined,
      });
      if (JSON_OUTPUT) console.log(JSON.stringify(data, null, 2));
      else {
        printMessages(data.messages);
        console.error(`-- cursor=${data.cursor} messages=${data.messages.length} --`);
      }
      return 0;
    }
    case 'wait': {
      const since = flags.since === undefined ? 0 : Number(flags.since);
      const timeoutSeconds = flags.timeout === undefined ? 120 : Number(flags.timeout);
      const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
      let cursor = since;
      while (Date.now() < deadline) {
        const data = await readMessages({
          since: cursor,
          limit: flags.limit === undefined ? 50 : Number(flags.limit),
          from: typeof flags.from === 'string' ? flags.from : undefined,
          to: typeof flags.to === 'string' ? flags.to : undefined,
        });
        cursor = Math.max(cursor, data.cursor ?? 0);
        if (data.messages.length > 0) {
          if (JSON_OUTPUT) console.log(JSON.stringify({ messages: data.messages, cursor }, null, 2));
          else {
            printMessages(data.messages);
            console.error(`-- cursor=${cursor} waited=${timeoutSeconds}s --`);
          }
          return 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      if (JSON_OUTPUT) console.log(JSON.stringify({ messages: [], cursor, timedOut: true }, null, 2));
      else console.error(`-- no new messages within ${timeoutSeconds}s (cursor=${cursor}) --`);
      return 2;
    }
    case 'watch': {
      const room = flags.room ?? 'general';
      const params = new URLSearchParams({ room });
      if (TOKEN) params.set('token', TOKEN);
      const response = await fetch(`${BASE}/api/stream?${params}`);
      if (!response.ok || response.body === null) throw new Error(`stream failed: HTTP ${response.status}`);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split(/\r?\n/u)) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data.length === 0) continue;
          if (event === 'hello') {
            console.error(`-- watching #${room} --`);
            continue;
          }
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (event === 'message') console.log(formatMessage(parsed) + '\n');
          else if (event === 'presence') console.error(`-- presence: ${parsed.agent} ${parsed.online ? 'online' : 'offline'} --`);
        }
      }
      return 0;
    }
    case 'switches': {
      const { switches } = await api('/api/switches');
      if (JSON_OUTPUT) console.log(JSON.stringify(switches, null, 2));
      else for (const name of ['claude', 'codex', 'dsh']) console.log(`${name}\t${switches[name] ? 'on' : 'off'}`);
      return 0;
    }
    case 'switch': {
      const agent = typeof flags.model === 'string' ? flags.model : typeof flags.agent === 'string' ? flags.agent : undefined;
      const enabled = flags.on === true ? true : flags.off === true ? false : undefined;
      if (agent === undefined || enabled === undefined) throw new Error('usage: switch --model claude|codex|dsh --on|--off');
      const data = await api('/api/switches', { method: 'POST', body: JSON.stringify({ agent, enabled }) });
      console.log(JSON_OUTPUT ? JSON.stringify(data.switches, null, 2) : `${agent}: ${enabled ? 'on' : 'off'}`);
      return 0;
    }
    default: {
      usage();
      return command === undefined || command === 'help' ? 0 : 1;
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`agent-hub: ${error.message}`);
    process.exit(1);
  });
