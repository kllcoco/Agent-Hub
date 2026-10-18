#!/usr/bin/env node
/**
 * Start Agent Hub detached on Windows (keeps running after the shell exits).
 *   node start.mjs            # start on 8787
 *   node start.mjs --port 8790 --open
 *   node start.mjs --stop     # stop the instance listening on the port
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : Number(process.env.PORT ?? 8787);
const open = argv.includes('--open');
const stop = argv.includes('--stop');

async function stopInstance() {
  const { execFileSync } = await import('node:child_process');
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`], { encoding: 'utf8' });
    const pids = output.split(/\s+/u).filter(Boolean);
    if (pids.length === 0) {
      console.log(`nothing is listening on ${port}`);
      return;
    }
    for (const pid of pids) {
      process.kill(Number(pid));
      console.log(`stopped pid ${pid} (port ${port})`);
    }
  } catch (error) {
    console.log(`could not stop the instance: ${error.message}`);
  }
}

if (stop) {
  await stopInstance();
  process.exit(0);
}

if (!existsSync(join(ROOT, 'data', 'logs'))) mkdirSync(join(ROOT, 'data', 'logs'), { recursive: true });
const stdout = openSync(join(ROOT, 'data', 'logs', 'server.out.log'), 'a');
const stderr = openSync(join(ROOT, 'data', 'logs', 'server.err.log'), 'a');
const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', stdout, stderr],
  env: { ...process.env, PORT: String(port) },
  windowsHide: true,
});
child.unref();
console.log(`Agent Hub started (pid ${child.pid}) on http://127.0.0.1:${port}`);
console.log(`logs: ${join(ROOT, 'data', 'logs', 'server.out.log')}`);
if (open) {
  const { execFile } = await import('node:child_process');
  execFile('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${port}`]);
}
