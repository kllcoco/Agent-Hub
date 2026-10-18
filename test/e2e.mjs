// End-to-end test for Agent Hub. Requires a running server (node server.mjs).
//   node test/e2e.mjs
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.HUB_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/u, '');
const ROOM = `e2e-${Date.now().toString(36)}`;
let failures = 0;

function check(condition, label, detail = '') {
  if (condition) {
    console.log(`ok: ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers ?? {}) };
  const response = await fetch(`${BASE}${path}`, { ...options, headers });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(value)}`);
  return value;
}

function post(agent, text, extra = {}) {
  return api(`/api/rooms/${ROOM}/messages`, { method: 'POST', body: JSON.stringify({ agent, text, ...extra }) });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const health = await api('/api/health');
  check(health.ok === true, 'health endpoint');

  const created = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: ROOM, topic: 'e2e room' }) });
  check(created.created === true || created.room.id === ROOM, 'room creation');

  const first = await post('claude', 'Claude checking in', { role: 'Claude Code' });
  check(first.message.seq === 1 && first.message.agent === 'claude', 'claude posts first message (seq 1)');
  check(typeof first.message.color === 'string' && first.message.color.startsWith('#'), 'server assigns an agent color');

  const second = await post('codex', 'Codex here, @dsh ready to split work', { to: 'dsh' });
  check(second.message.to === 'dsh', 'directed message keeps its "to" target');

  const third = await post('dsh', 'dsh joined as coordinator', { kind: 'decision' });
  check(third.message.kind === 'decision', 'message kind is stored');

  const all = await api(`/api/rooms/${ROOM}/messages?since=0`);
  check(all.messages.length === 3, 'read returns all three messages', `got ${all.messages.length}`);
  check(all.cursor === 3, 'cursor equals last seq', `got ${all.cursor}`);
  check(all.messages.map((message) => message.seq).join(',') === '1,2,3', 'messages are ordered by seq');

  const tail = await api(`/api/rooms/${ROOM}/messages?since=2`);
  check(tail.messages.length === 1 && tail.messages[0].agent === 'dsh', 'since cursor only returns newer messages');

  const fromClaude = await api(`/api/rooms/${ROOM}/messages?agent=claude`);
  check(fromClaude.messages.length === 1 && fromClaude.messages[0].agent === 'claude', 'agent filter works');

  const toDsh = await api(`/api/rooms/${ROOM}/messages?to=dsh`);
  check(toDsh.messages.length === 1 && toDsh.messages[0].agent === 'codex', 'to filter works');

  await api('/api/agents/presence', { method: 'POST', body: JSON.stringify({ agent: 'claude', role: 'Claude Code' }) });
  const agents = await api('/api/agents');
  check(agents.agents.some((agent) => agent.agent === 'claude' && agent.online === true), 'presence registration works');

  // SSE: subscribe, post, and expect the message event.
  const controller = new AbortController();
  const streamResponse = await fetch(`${BASE}/api/stream?room=${ROOM}`, { signal: controller.signal });
  check(streamResponse.ok && (streamResponse.headers.get('content-type') ?? '').includes('text/event-stream'), 'SSE stream opens');
  const reader = streamResponse.body.getReader();
  let streamText = '';
  const streamPromise = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        streamText += new TextDecoder().decode(value);
        if (streamText.includes('sse-check')) break;
      }
    } catch {
      /* aborted */
    }
  })();
  await sleep(400);
  await post('codex', 'sse-check from codex');
  await Promise.race([streamPromise, sleep(6000)]);
  controller.abort();
  check(streamText.includes('event: message') && streamText.includes('sse-check'), 'SSE delivers new messages');

  // CLI integration.
  const cliRead = spawnSync(process.execPath, [join(ROOT, 'cli.mjs'), 'read', '--agent', 'cli-agent', '--room', ROOM, '--since', '0', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HUB_URL: BASE },
    cwd: ROOT,
  });
  let cliData;
  try {
    cliData = JSON.parse(cliRead.stdout);
  } catch {
    cliData = undefined;
  }
  check(cliRead.status === 0 && Array.isArray(cliData?.messages) && cliData.messages.length === 4, 'CLI read returns JSON messages', cliRead.stderr);

  const cliSend = spawnSync(process.execPath, [join(ROOT, 'cli.mjs'), 'send', '--agent', 'cli-agent', '--room', ROOM, '--text', 'from the CLI', '--kind', 'note'], {
    encoding: 'utf8',
    env: { ...process.env, HUB_URL: BASE },
    cwd: ROOT,
  });
  check(cliSend.status === 0 && /sent #5/.test(cliSend.stdout), 'CLI send posts a message', cliSend.stdout + cliSend.stderr);

  // MCP integration over stdio.
  const mcp = spawn(process.execPath, [join(ROOT, 'mcp.mjs'), '--agent', 'e2e-mcp', '--url', BASE], { stdio: ['pipe', 'pipe', 'pipe'] });
  let mcpOut = '';
  mcp.stdout.on('data', (chunk) => {
    mcpOut += chunk.toString();
  });
  const sendRpc = (value) => mcp.stdin.write(JSON.stringify(value) + '\n');
  sendRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
  sendRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  sendRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hub_send', arguments: { room: ROOM, text: 'hello from MCP', kind: 'message' } } });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((mcpOut.match(/"id":3/gu) ?? []).length > 0) break;
    await sleep(100);
  }
  mcp.kill();
  let mcpLines = mcpOut.split(/\r?\n/u).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  });
  const toolList = mcpLines.find((line) => line?.id === 2)?.result?.tools;
  const toolCall = mcpLines.find((line) => line?.id === 3)?.result;
  check(Array.isArray(toolList) && toolList.some((tool) => tool.name === 'hub_send'), 'MCP tools/list exposes hub tools');
  let mcpPayload;
  try {
    mcpPayload = JSON.parse(toolCall?.content?.[0]?.text ?? '{}');
  } catch {
    mcpPayload = undefined;
  }
  check(toolCall !== undefined && toolCall.isError !== true && mcpPayload?.sent === true, 'MCP tools/call posts a message');

  const after = await api(`/api/rooms/${ROOM}/messages?since=0`);
  check(after.messages.some((message) => message.agent === 'e2e-mcp'), 'MCP-posted message is visible in the room');

  const del = await api(`/api/rooms/${ROOM}`, { method: 'DELETE' });
  check(del.deleted === ROOM, 'room deletion works');
} catch (error) {
  failures += 1;
  console.log(`ERROR: ${error.stack ?? error.message}`);
  try {
    await api(`/api/rooms/${ROOM}`, { method: 'DELETE' });
  } catch {
    /* ignore cleanup failure */
  }
}

console.log(`\nRESULT ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
