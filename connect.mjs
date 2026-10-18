#!/usr/bin/env node
/**
 * Wire the local Claude Code and Codex CLI installations to the Agent Hub.
 *
 *   node connect.mjs all        # register the hub MCP server in both
 *   node connect.mjs claude
 *   node connect.mjs codex
 *   node connect.mjs status     # show detected CLIs + registered MCP servers
 *   node connect.mjs remove     # unregister from both
 *
 * Uses each CLI's own `mcp add/remove` command, so edits stay reversible and
 * inside the tool's supported configuration path.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MCP_PATH = join(ROOT, 'mcp.mjs');
const NODE = process.execPath;
const argv = process.argv.slice(2);
const command = argv[0] ?? 'status';
const BASE = String(flagValue('--url') ?? process.env.HUB_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/u, '');
const SERVER_NAME = 'agent-hub';

function flagValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function runCapture(file, args) {
  try {
    const output = execFileSync(file, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output: output.trim() };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message };
  }
}

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
  const claudeData = join(localAppData, 'Claude-Data');
  if (existsSync(claudeData)) {
    for (const entry of readdirSync(claudeData, { withFileTypes: true })) {
      if (entry.isDirectory()) collect(join(claudeData, entry.name, 'claude-code'));
    }
  }
  const packageRoot = join(localAppData, 'Packages');
  if (existsSync(packageRoot)) {
    for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('Claude_')) {
        collect(join(packageRoot, entry.name, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
      }
    }
  }
  return newest(candidates);
}

function findCodex() {
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

function alreadyRegistered(cli, listArgs) {
  const result = runCapture(cli, listArgs);
  return result.ok && result.output.includes(SERVER_NAME);
}

function unregisterClaude(claude) {
  if (alreadyRegistered(claude, ['mcp', 'list'])) runCapture(claude, ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
}

function unregisterCodex(codex) {
  if (alreadyRegistered(codex, ['mcp', 'list'])) runCapture(codex, ['mcp', 'remove', SERVER_NAME]);
}

function registerClaude() {
  const claude = findClaude();
  if (claude === undefined) {
    console.log('Claude Code CLI not found (looked on PATH and in the Claude desktop package).');
    return false;
  }
  unregisterClaude(claude);
  const args = ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', NODE, MCP_PATH, '--agent', 'claude', '--url', BASE];
  const result = runCapture(claude, args);
  console.log(`claude: ${claude}`);
  console.log(result.ok ? `  registered MCP server "${SERVER_NAME}" (user scope)` : `  failed: ${result.output}`);
  return result.ok;
}

function registerCodex() {
  const codex = findCodex();
  if (codex === undefined) {
    console.log('Codex CLI not found (looked on PATH and in %LOCALAPPDATA%\\OpenAI\\Codex\\bin).');
    return false;
  }
  unregisterCodex(codex);
  const args = ['mcp', 'add', SERVER_NAME, '--env', 'HUB_AGENT=codex', '--', NODE, MCP_PATH, '--agent', 'codex', '--url', BASE];
  const result = runCapture(codex, args);
  console.log(`codex: ${codex}`);
  console.log(result.ok ? `  registered MCP server "${SERVER_NAME}"` : `  failed: ${result.output}`);
  return result.ok;
}

function status() {
  const claude = findClaude();
  const codex = findCodex();
  console.log(`hub url : ${BASE}`);
  console.log(`mcp     : ${MCP_PATH}`);
  console.log(`node    : ${NODE}`);
  console.log(`claude  : ${claude ?? 'not found'}`);
  if (claude !== undefined) {
    const list = runCapture(claude, ['mcp', 'list']);
    console.log(list.ok ? list.output.replace(/^/gmu, '          ') : `          list failed: ${list.output}`);
  }
  console.log(`codex   : ${codex ?? 'not found'}`);
  if (codex !== undefined) {
    const list = runCapture(codex, ['mcp', 'list']);
    console.log(list.ok ? list.output.replace(/^/gmu, '          ') : `          list failed: ${list.output}`);
  }
}

function removeAll() {
  const claude = findClaude();
  const codex = findCodex();
  if (claude !== undefined) {
    unregisterClaude(claude);
    console.log('claude: MCP server removed (if it was registered)');
  }
  if (codex !== undefined) {
    unregisterCodex(codex);
    console.log('codex: MCP server removed (if it was registered)');
  }
}

console.log('Agent Hub connector');
console.log(`hub : ${BASE}`);
console.log(`mcp : ${MCP_PATH}\n`);

switch (command) {
  case 'all': {
    const claudeOk = registerClaude();
    registerCodex();
    console.log(claudeOk ? '\nClaude Code: restart or start a new `claude` session, then ask it to join the hub.' : '');
    console.log('Codex: start a new `codex` session, then ask it to join the hub.');
    break;
  }
  case 'claude':
    registerClaude();
    break;
  case 'codex':
    registerCodex();
    break;
  case 'remove':
    removeAll();
    break;
  case 'status':
  default:
    status();
    break;
}
