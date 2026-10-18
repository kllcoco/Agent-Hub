#!/usr/bin/env node
/**
 * Build a single-file desktop copy of the Agent Hub dashboard.
 *
 *   node build-desktop.mjs
 *   node build-desktop.mjs --out "<Desktop>/Agent-Hub.html"
 *   node build-desktop.mjs --url http://127.0.0.1:8787
 *
 * The HTML inlines style.css and app.js and points API/SSE at the running hub,
 * so it works when opened from the Desktop via file:// as long as the server
 * (server.mjs) is running.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const HUB_URL = String(flag('url', process.env.HUB_URL ?? 'http://127.0.0.1:8787')).replace(/\/+$/u, '');

function findDesktop() {
  const candidates = [
    process.env.OneDrive ? join(process.env.OneDrive, 'Desktop') : undefined,
    join(homedir(), 'Desktop'),
    join(homedir(), 'OneDrive', 'Desktop'),
  ].filter((value) => typeof value === 'string' && existsSync(value));
  return candidates[0] ?? join(homedir(), 'Desktop');
}

const outPath = flag('--out', join(findDesktop(), 'Agent-Hub.html'));

const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');
const js = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8')
  .replaceAll('</script>', '<\\/script>')
  .replaceAll('</style>', '<\\/style>');

const STYLESHEET_TAG = '  <link rel="stylesheet" href="/style.css" />';
const SCRIPT_TAG = '  <script type="module" src="/app.js"></script>';
if (!html.includes(STYLESHEET_TAG) || !html.includes(SCRIPT_TAG)) {
  console.error('index.html no longer contains the expected asset tags; update build-desktop.mjs');
  process.exit(1);
}

const logosDir = join(ROOT, 'public', 'logos');
const logos = {};
if (existsSync(logosDir)) {
  for (const file of readdirSync(logosDir)) {
    if (!file.endsWith('.svg')) continue;
    const key = file.slice(0, -4);
    logos[key] = `data:image/svg+xml;base64,${readFileSync(join(logosDir, file)).toString('base64')}`;
  }
}

const built = html
  .replace(STYLESHEET_TAG, `  <style>\n${css}\n  </style>`)
  .replace(
    SCRIPT_TAG,
    `  <script>window.__AGENT_HUB_URL__ = ${JSON.stringify(HUB_URL)}; window.__AGENT_HUB_LOGOS__ = ${JSON.stringify(logos)};</script>\n  <script type="module">\n${js}\n  </script>`,
  );

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, built, 'utf8');
const bytes = Buffer.byteLength(built);
console.log(`wrote ${outPath} (${(bytes / 1024).toFixed(1)} KiB)`);
console.log(`hub url baked in: ${HUB_URL}`);
console.log('open it from the Desktop; start the hub first with start.cmd or node start.mjs --open');
