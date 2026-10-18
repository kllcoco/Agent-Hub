#!/usr/bin/env node
/**
 * Agent Hub connectivity & wiring check.
 *
 * Verifies the running hub, our own MCP server + CLI, the DSH native MCP row,
 * and the Claude Code / Claude Desktop / Codex MCP configurations.
 * It never starts a Claude or ChatGPT/Codex model session: harness configs are
 * inspected from their files only.
 *
 *   node check.mjs            # human-readable report
 *   node check.mjs --json     # machine-readable report
 *   node check.mjs --url http://127.0.0.1:8787
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MCP = join(ROOT, 'mcp.mjs');
const CLI = join(ROOT, 'cli.mjs');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const BASE = String(flag('url', process.env.HUB_URL ?? 'http://127.0.0.1:8787')).replace(/\/+$/u, '');
const TOKEN = String(process.env.HUB_TOKEN ?? '');
const JSON_OUT = argv.includes('--json');
const HOME = homedir();
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local');
const APPDATA = process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming');

const results = [];
function record(group, name, status, detail = '') {
  results.push({ group, name, status, detail });
}
const pass = (group, name, detail) => record(group, name, 'pass', detail);
const warn = (group, name, detail) => record(group, name, 'warn', detail);
const fail = (group, name, detail) => record(group, name, 'fail', detail);
const info = (group, name, detail) => record(group, name, 'info', detail);

function mask(value, secret = TOKEN) {
  if (typeof value !== 'string' || secret.length === 0) return value;
  return value.split(secret).join('***');
}

async function fetchJson(path) {
  const headers = {};
  if (TOKEN) headers['x-hub-token'] = TOKEN;
  const response = await fetch(`${BASE}${path}`, { headers });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${mask(typeof body === 'string' ? body : JSON.stringify(body))}`);
  return body;
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr: `${stderr}\ntimeout`, timedOut: true });
    }, options.timeoutMs ?? 15_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}`, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

/** Spawn our own MCP server and run initialize -> tools/list -> hub_join -> hub_read. */
function checkMcpHandshake(agent = 'checker') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MCP, '--agent', agent, '--url', BASE], {
      cwd: ROOT,
      env: { ...process.env, HUB_URL: BASE, HUB_AGENT: agent },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buffer = '';
    let stderr = '';
    const responses = new Map();
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve({ reason, responses, stderr });
    };
    const timer = setTimeout(() => finish('timeout'), 12_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length === 0) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined) responses.set(message.id, message);
        } catch {
          /* ignore non JSON-RPC noise */
        }
      }
      if ([1, 2, 3, 4].every((id) => responses.has(id))) finish('ok');
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish('error');
    });
    const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-hub-check', version: '1.0.0' } } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hub_join', arguments: { role: 'connectivity checker' } } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hub_read', arguments: { room: 'general', limit: 3 } } });
  });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return undefined;
  }
}

function commandExists(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.includes('\\') || path.includes('/') || /^[a-zA-Z]:/u.test(path)) return existsSync(path);
  return true; // bare command names are resolved by the harness at launch
}

async function checkHub() {
  const group = 'Hub 服务';
  try {
    const health = await fetchJson('/api/health');
    pass(group, `health ${BASE}/api/health`, `v${health.version} · ${health.rooms} rooms · ${health.agents} agents online`);
  } catch (error) {
    fail(group, `health ${BASE}/api/health`, mask(error.message));
    return;
  }

  try {
    const rooms = await fetchJson('/api/rooms');
    const general = rooms.rooms.find((room) => room.id === 'general');
    pass(group, 'rooms API', `${rooms.rooms.length} rooms${general ? ` · general has ${general.messageCount} messages` : ''}`);
  } catch (error) {
    fail(group, 'rooms API', mask(error.message));
  }

  try {
    const headers = {};
    if (TOKEN) headers['x-hub-token'] = TOKEN;
    const response = await fetch(`${BASE}/`, { headers });
    const html = await response.text();
    if (response.ok && html.includes('Agent Hub')) pass(group, 'web dashboard', `HTTP ${response.status} · ${html.length} bytes`);
    else fail(group, 'web dashboard', `HTTP ${response.status}`);
  } catch (error) {
    fail(group, 'web dashboard', mask(error.message));
  }

  try {
    const switches = await fetchJson('/api/switches');
    const state = switches.switches ?? {};
    pass(group, 'model switches', `claude=${state.claude ? 'on' : 'off'} · codex=${state.codex ? 'on' : 'off'} · dsh=${state.dsh ? 'on' : 'off'}`);
  } catch (error) {
    fail(group, 'model switches', mask(error.message));
  }

  try {
    const agents = await fetchJson('/api/agents');
    info(group, 'online agents', agents.agents.map((agent) => `${agent.agent}${agent.role ? ` (${agent.role})` : ''}`).join(', ') || 'none');
  } catch {
    /* already reported above */
  }
}

async function checkWorker() {
  const group = 'Worker 后台';
  const workerFile = join(ROOT, 'worker.mjs');
  if (existsSync(workerFile)) pass(group, 'worker.mjs exists', workerFile);
  else fail(group, 'worker.mjs exists', workerFile);
  try {
    const agents = await fetchJson('/api/agents');
    const worker = agents.agents.find((agent) => agent.agent === 'worker');
    if (worker) pass(group, 'worker online', `role: ${worker.role || 'worker daemon'}`);
    else warn(group, 'worker online', 'not running — start it with: node worker.mjs');
  } catch (error) {
    fail(group, 'worker online', mask(error.message));
  }
  info(group, 'quota guard', 'switches default OFF; worker starts no model CLI until the human enables that model');
}

async function checkMcp() {
  const group = 'Agent Hub MCP server（本仓库）';
  if (!existsSync(MCP)) {
    fail(group, 'mcp.mjs exists', MCP);
    return;
  }
  pass(group, 'mcp.mjs exists', MCP);
  const handshake = await checkMcpHandshake();
  const init = handshake.responses.get(1)?.result;
  const tools = handshake.responses.get(2)?.result?.tools;
  const joined = handshake.responses.get(3)?.result;
  const read = handshake.responses.get(4)?.result;
  if (handshake.reason === 'ok' && init?.serverInfo?.name === 'agent-hub') pass(group, 'MCP initialize', `server ${init.serverInfo.name} v${init.serverInfo.version ?? '?'}, protocol ${init.protocolVersion}`);
  else fail(group, 'MCP initialize', `${handshake.reason}${handshake.stderr ? ` · ${mask(handshake.stderr.trim().slice(-300))}` : ''}`);
  const required = ['hub_join', 'hub_read', 'hub_send', 'hub_wait', 'hub_rooms', 'hub_agents'];
  const names = Array.isArray(tools) ? tools.map((tool) => tool.name) : [];
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length === 0) pass(group, 'MCP tools/list', `${names.length} tools: ${names.join(', ')}`);
  else fail(group, 'MCP tools/list', `missing: ${missing.join(', ')}`);
  let joinedPayload;
  try {
    joinedPayload = JSON.parse(joined?.content?.[0]?.text ?? '{}');
  } catch {
    joinedPayload = undefined;
  }
  if (joinedPayload?.joined === 'checker' && joinedPayload.online === true) pass(group, 'MCP hub_join', `joined as ${joinedPayload.joined} (presence only)`);
  else fail(group, 'MCP hub_join', JSON.stringify(joined ?? {}).slice(0, 300));
  let readPayload;
  try {
    readPayload = JSON.parse(read?.content?.[0]?.text ?? '{}');
  } catch {
    readPayload = undefined;
  }
  if (Array.isArray(readPayload?.messages)) pass(group, 'MCP hub_read', `cursor=${readPayload.cursor} · ${readPayload.count ?? readPayload.messages.length} messages`);
  else fail(group, 'MCP hub_read', JSON.stringify(read ?? {}).slice(0, 300));
}

async function checkCli() {
  const group = 'CLI 客户端';
  if (!existsSync(CLI)) {
    fail(group, 'cli.mjs exists', CLI);
    return;
  }
  pass(group, 'cli.mjs exists', CLI);
  const result = await spawnCapture(process.execPath, [CLI, 'health', '--json'], { env: { HUB_URL: BASE, HUB_TOKEN: TOKEN }, timeoutMs: 15_000 });
  if (result.code === 0) {
    try {
      const value = JSON.parse(result.stdout);
      if (value.ok === true) pass(group, 'cli.mjs health', `v${value.version} · ${value.rooms} rooms`);
      else fail(group, 'cli.mjs health', result.stdout.slice(0, 300));
    } catch {
      fail(group, 'cli.mjs health', `unparsable output: ${result.stdout.slice(0, 200)}`);
    }
  } else {
    fail(group, 'cli.mjs health', mask((result.stderr || result.stdout).trim().slice(-400)));
  }
}

async function checkDshRow() {
  const group = 'DSH 原生 MCP 行';
  const profileDir = join(HOME, '.dsh', 'profiles', 'desktop');
  const profileFile = join(profileDir, 'package.json');
  if (!existsSync(profileFile)) {
    fail(group, 'desktop profile', profileFile);
    return;
  }
  const profile = readJson(profileFile);
  const spec = profile?.dependencies?.['@local/agent-hub-mcp'];
  if (typeof spec === 'string') pass(group, 'profile dependency', spec);
  else fail(group, 'profile dependency', '@local/agent-hub-mcp missing from desktop profile dependencies');

  const bundles = profile?.dsh?.profile?.bundles ?? [];
  if (bundles.includes('@local/agent-hub-mcp')) pass(group, 'profile bundles', 'selected');
  else fail(group, 'profile bundles', '@local/agent-hub-mcp is not selected');

  if (typeof spec === 'string') {
    const clean = spec.replace(/^(?:link:|file:)/u, '').replace(/\//gu, '\\');
    const bundleDir = /^[a-zA-Z]:/u.test(clean) ? clean : join(profileDir, clean);
    const patchFile = join(bundleDir, 'cordis.patch.yml');
    if (existsSync(patchFile)) {
      const patch = readFileSync(patchFile, 'utf8');
      const referencesClient = patch.includes('@deepseek-ai/dsh-mcp-client');
      const referencesServer = patch.includes('mcp.mjs') && patch.includes('agent-hub');
      if (referencesClient && referencesServer) pass(group, 'bundle patch', `${patchFile} inserts the MCP client row`);
      else fail(group, 'bundle patch', `missing ${!referencesClient ? 'dsh-mcp-client' : ''} ${!referencesServer ? 'mcp.mjs/agent-hub' : ''}`);
    } else {
      fail(group, 'bundle patch', `not found: ${patchFile}`);
    }
    const installed = join(profileDir, 'node_modules', '@local', 'agent-hub-mcp');
    if (existsSync(installed)) pass(group, 'installed package', installed);
    else warn(group, 'installed package', `not found: ${installed}`);
  }

  const hubPresence = await fetchJson('/api/agents').catch(() => undefined);
  const dshAgent = hubPresence?.agents?.find((agent) => agent.agent === 'dsh');
  if (dshAgent) info(group, 'hub presence', `dsh online${dshAgent.role ? ` (${dshAgent.role})` : ''}`);
  else warn(group, 'hub presence', 'dsh is not online right now — the Harness MCP row may be stopped; it reconnects automatically');
}

function checkClaudeCode() {
  const group = 'Claude Code CLI';
  const configFile = join(HOME, '.claude.json');
  const config = readJson(configFile);
  if (config === undefined) {
    fail(group, '~/.claude.json', `missing or unreadable: ${configFile}`);
    return;
  }
  const server = config?.mcpServers?.['agent-hub'];
  if (server === undefined) {
    fail(group, 'mcpServers.agent-hub', 'not registered (run: node connect.mjs claude)');
    return;
  }
  pass(group, 'mcpServers.agent-hub', 'registered (user scope)');
  if (commandExists(server.command)) pass(group, 'command', server.command);
  else fail(group, 'command', `not found: ${server.command}`);
  const args = Array.isArray(server.args) ? server.args : [];
  const script = args.find((arg) => typeof arg === 'string' && arg.endsWith('mcp.mjs'));
  if (script !== undefined && existsSync(script)) pass(group, 'MCP script', script);
  else fail(group, 'MCP script', script ?? 'args do not include mcp.mjs');
  info(group, 'login', 'CLI login status not probed (checking it would start the Claude CLI); run `claude` once and use /login if needed');
}

function findClaudeDesktopConfig() {
  const candidates = [];
  const claudeData = join(LOCALAPPDATA, 'Claude-Data');
  if (existsSync(claudeData)) {
    for (const entry of readdirSync(claudeData, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(claudeData, entry.name, 'claude_desktop_config.json'));
    }
  }
  const packagesDir = join(LOCALAPPDATA, 'Packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('Claude_')) continue;
      candidates.push(join(packagesDir, entry.name, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
    }
  }
  candidates.push(join(APPDATA, 'Claude', 'claude_desktop_config.json'));
  return candidates;
}

function checkClaudeDesktop() {
  const group = 'Claude Desktop';
  const candidates = findClaudeDesktopConfig().filter((path) => existsSync(path));
  if (candidates.length === 0) {
    warn(group, 'claude_desktop_config.json', 'not found (is Claude Desktop installed?)');
    return;
  }
  const configFile = candidates[0];
  const config = readJson(configFile);
  const server = config?.mcpServers?.['agent-hub'];
  if (server === undefined) {
    fail(group, 'mcpServers.agent-hub', `not registered in ${configFile}`);
    return;
  }
  pass(group, 'mcpServers.agent-hub', configFile);
  if (commandExists(server.command)) pass(group, 'command', server.command);
  else fail(group, 'command', `not found: ${server.command}`);
  const args = Array.isArray(server.args) ? server.args : [];
  const script = args.find((arg) => typeof arg === 'string' && arg.endsWith('mcp.mjs'));
  if (script !== undefined && existsSync(script)) pass(group, 'MCP script', script);
  else fail(group, 'MCP script', script ?? 'args do not include mcp.mjs');
  const dir = dirname(configFile);
  const backups = readdirSync(dir).filter((name) => name.startsWith('claude_desktop_config.json.bak-'));
  if (backups.length > 0) info(group, 'backups', backups.join(', '));
  info(group, 'restart', 'MCP is loaded by the running Claude Desktop; quit Claude before editing this file, then reopen it');
}

function checkCodex() {
  const group = 'ChatGPT / Codex';
  const configFile = join(HOME, '.codex', 'config.toml');
  if (!existsSync(configFile)) {
    fail(group, '~/.codex/config.toml', `missing: ${configFile}`);
    return;
  }
  const text = readFileSync(configFile, 'utf8');
  const header = /^\[mcp_servers\.agent-hub\]\s*$/mu.exec(text);
  if (header === null) {
    fail(group, '[mcp_servers.agent-hub]', 'not registered (run: node connect.mjs codex)');
    return;
  }
  pass(group, '[mcp_servers.agent-hub]', 'registered');
  const afterHeader = text.slice(header.index + header[0].length);
  const nextSection = /^\[/mu.exec(afterHeader);
  const body = nextSection === null ? afterHeader : afterHeader.slice(0, nextSection.index);
  const command = /command\s*=\s*'([^']+)'/u.exec(body)?.[1] ?? /command\s*=\s*"([^"]+)"/u.exec(body)?.[1];
  if (command !== undefined && commandExists(command)) pass(group, 'command', command);
  else fail(group, 'command', command ?? 'command not found in section');
  const referencesScript = body.includes('mcp.mjs');
  if (referencesScript) pass(group, 'MCP script', 'args reference mcp.mjs');
  else fail(group, 'MCP script', 'args do not reference mcp.mjs');
  const hasAgentEnv = /HUB_AGENT\s*=\s*"codex"/u.test(text) || /HUB_AGENT\s*=\s*'codex'/u.test(text);
  if (hasAgentEnv) pass(group, 'identity', 'HUB_AGENT=codex');
  else warn(group, 'identity', 'HUB_AGENT=codex not found (agent may report a default name)');
  info(group, 'restart', 'restart the ChatGPT/Codex app after changing this MCP config; no model session was started by this check');
}

async function main() {
  if (!JSON_OUT) {
    console.log(`Agent Hub check · ${BASE}`);
    console.log(`node ${process.version} · ${new Date().toISOString()}\n`);
  }
  await checkHub();
  await checkMcp();
  await checkCli();
  await checkDshRow();
  await checkWorker();
  checkClaudeCode();
  checkClaudeDesktop();
  checkCodex();

  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const entry of results) counts[entry.status] += 1;

  if (JSON_OUT) {
    console.log(JSON.stringify({ url: BASE, time: new Date().toISOString(), counts, results }, null, 2));
  } else {
    const icons = { pass: '✓', warn: '!', fail: '✗', info: '·' };
    let lastGroup = null;
    for (const entry of results) {
      if (entry.group !== lastGroup) {
        if (lastGroup !== null) console.log('');
        console.log(`[${entry.group}]`);
        lastGroup = entry.group;
      }
      console.log(`  ${icons[entry.status]} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
    }
    console.log(`\nRESULT  ${counts.pass} pass · ${counts.warn} warn · ${counts.fail} fail${counts.info ? ` · ${counts.info} info` : ''}`);
    console.log(counts.fail === 0 ? 'All required checks passed.' : 'Fix the ✗ items above, then re-run.');
  }
  process.exit(counts.fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`agent-hub check failed: ${error.message}`);
  process.exit(1);
});
