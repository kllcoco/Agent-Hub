#!/usr/bin/env node
/**
 * Minimal Agent Hub HTTP client (no MCP, no dependencies).
 *
 * Use this when your harness can make HTTP calls but cannot speak MCP. The hub
 * itself only coordinates messages/presence — it does not provide file or shell
 * tools. For tool-using agents prefer MCP (mcp.mjs) so they get hub_read /
 * hub_send / hub_wait as real tools.
 *
 *   node examples/api-client.mjs join  --agent my-bot --role "my harness"
 *   node examples/api-client.mjs send  --agent my-bot --text "hello" [--kind message] [--to codex]
 *   node examples/api-client.mjs read  --agent my-bot [--limit 20] [--since 0]
 *
 * Global flags: --url http://127.0.0.1:8787 · --token <HUB_TOKEN>
 */
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const base = String(value('url', process.env.HUB_URL ?? 'http://127.0.0.1:8787')).replace(/\/+$/u, '');
const token = value('token', process.env.HUB_TOKEN ?? '');
const command = argv[0];
const agent = value('agent', 'api-client');
const room = value('room', 'general');

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (token) headers['x-hub-token'] = token;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status} ${data.error ?? text}`);
  return data;
}

if (command === 'join') {
  const data = await api('/api/agents/presence', {
    method: 'POST',
    body: JSON.stringify({ agent, role: value('role', 'http client') }),
  });
  console.log(JSON.stringify(data, null, 2));
} else if (command === 'send') {
  const text = value('text');
  if (!text) throw new Error('--text is required');
  const body = { agent, role: value('role', 'http client'), kind: value('kind', 'message'), text };
  const to = value('to');
  if (to) body.to = to;
  const data = await api(`/api/rooms/${encodeURIComponent(room)}/messages`, { method: 'POST', body: JSON.stringify(body) });
  console.log(`sent #${data.message.seq} to #${room}`);
} else if (command === 'read') {
  const query = new URLSearchParams({ limit: value('limit', '20'), since: value('since', '0') });
  const data = await api(`/api/rooms/${encodeURIComponent(room)}/messages?${query}`);
  for (const message of data.messages) console.log(`#${message.seq} ${message.agent}: ${message.text}`);
} else {
  console.log('usage: node examples/api-client.mjs join|send|read --agent <name> [--text ...] [--url ...]');
  process.exit(1);
}
