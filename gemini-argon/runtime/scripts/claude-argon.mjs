import { createHash } from 'node:crypto';
import { checkPrivateFile } from './portable-state.mjs';
import './portable-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = process.env.ARGON_STATE_DIR || path.join(process.env.HOME, 'Library/Application Support/gemini-argon-skill');
const base = `http://127.0.0.1:${process.env.ARGON_PORT || 18185}`;
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv[2] === '--import-auth') {
  try {
    const { importAppAuth } = await import('./import-app-auth.mjs');
    console.log(JSON.stringify(await importAppAuth(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
}
if (process.argv[2] === '--auth-status') {
  const { credentials } = await import('./auth-store.mjs');
  console.log(JSON.stringify(credentials.status(), null, 2)); process.exit(0);
}
async function ready() {
  let health;
  try { const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(700) }); health = response.ok ? await response.json() : null; }
  catch { return false; }
  if (health?.model !== 'gemini-argon-app') { if (health) throw new Error('本机端口已被其他服务使用，请更换 ARGON_PORT。'); return false; }
  const tokenFile = path.join(directory, 'gateway-token'); checkPrivateFile(tokenFile);
  const expected = createHash('sha256').update(fs.readFileSync(tokenFile, 'utf8').trim()).digest('hex');
  if (health.distribution !== 'gemini-argon-skill-v1' || health.instance !== expected) throw new Error('本机端口属于其他桥接实例，请更换 ARGON_PORT；不会终止其他服务。');
  if (health.protocolVersion !== 2) throw new Error('An older Argon gateway is still running. Restart that local gateway before using client tools.');
  return true;
}
if (!await ready()) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const logfile = path.join(directory, 'gateway.log');
  const log = fs.openSync(logfile, 'a', 0o600); fs.chmodSync(logfile, 0o600);
  const service = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: process.env, detached: true, stdio: ['ignore', log, log] });
  service.on('error', () => {}); service.unref(); fs.closeSync(log);
  const started = Date.now();
  while (!await ready()) {
    if (Date.now() - started > 5000) throw new Error('Argon gateway failed to start; inspect the private gateway.log');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}
const token = fs.readFileSync(path.join(directory, 'gateway-token'), 'utf8').trim();
const env = { ...process.env, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: token, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
const child = spawn(process.env.ARGON_CLAUDE_BIN || path.join(process.env.HOME, '.local/bin/claude'), [
  '--bare', '--setting-sources', '', '--tools', 'default', '--model', 'gemini-argon-app',
  ...process.argv.slice(2),
], { env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code; });
