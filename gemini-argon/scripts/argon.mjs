#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { stateDirectory, settings } from '../runtime/scripts/portable-config.mjs';
import { ensurePrivateDirectory, checkPrivateFile } from '../runtime/scripts/portable-state.mjs';
import { findAppBinary, verifiedBinary, VERIFIED_APP_VERSION } from '../runtime/scripts/portable-template.mjs';
import { CredentialManager, writePrivateJson } from '../runtime/scripts/auth-store.mjs';

export const skillRoot = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(skillRoot, 'runtime');
const oauth = path.join(stateDirectory, 'oauth.json');
const manager = () => new CredentialManager({ filename: oauth });

function line(checks, name, ok, detail, action) { checks.push({ name, status: ok ? 'ok' : 'action_required', detail, ...(action ? { action } : {}) }); }
export function validProxy(value) {
  if (value === 'direct') return value;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('仅支持 direct 或无账号密码的本机 HTTP 代理；不会导入远程代理凭据。');
  return url.origin;
}
function executable(filename) { try { fs.accessSync(filename, fs.constants.X_OK); return fs.statSync(filename).isFile(); } catch { return false; } }
export function findClaude() {
  if (process.env.ARGON_CLAUDE_BIN) return executable(process.env.ARGON_CLAUDE_BIN) ? process.env.ARGON_CLAUDE_BIN : null;
  return [...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(p => path.join(p, 'claude')), path.join(os.homedir(), '.local/bin/claude')].find(executable) || null;
}
async function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(200, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false));
  });
}
async function detectProxy() {
  if (process.env.ARGON_PROXY) return validProxy(process.env.ARGON_PROXY);
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    try { if (process.env[name]) return validProxy(process.env[name]); } catch { /* Do not reuse remote/credential-bearing proxy configuration. */ }
  }
  if (process.platform === 'darwin') {
    try {
      const text = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 });
      for (const kind of ['HTTPS', 'HTTP']) {
        if (!new RegExp(`${kind}Enable\\s*:\\s*1`).test(text)) continue;
        const host = text.match(new RegExp(`${kind}Proxy\\s*:\\s*(\\S+)`))?.[1];
        const port = text.match(new RegExp(`${kind}Port\\s*:\\s*(\\d+)`))?.[1];
        if (host && port) return validProxy(`http://${host}:${port}`);
      }
    } catch { /* A system proxy is optional. */ }
  }
  for (const port of [7897, 7890, 1087]) if (await listening(port)) return `http://127.0.0.1:${port}`;
  return 'direct';
}

function dependencyReady() {
  const require = createRequire(path.join(runtime, 'package.json'));
  try {
    return ['ajv', 'ajv-formats'].every(name => require.resolve(name).startsWith(path.join(runtime, 'node_modules') + path.sep));
  } catch { return false; }
}
async function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'inherit', ...options });
    child.once('error', () => reject(new Error('命令启动失败；请检查 Node/npm/Claude Code 的安装。')));
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

export function verifyManifest(root = skillRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('分享包清单无效。');
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' || item.path.includes('\\') || item.path.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('分享包清单包含非法路径。');
    const filename = path.join(root, item.path);
    let current = root;
    for (const part of item.path.split('/')) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new Error('分享包不能包含符号链接。'); }
    if (!fs.statSync(filename).isFile() || createHash('sha256').update(fs.readFileSync(filename)).digest('hex') !== item.sha256) throw new Error('分享包文件不完整或已变更，请重新解压可信副本。');
  }
  return { files: manifest.files.length, integrityVerified: true, publisherSignatureVerified: false };
}

export async function verifyAuthorization({ repair = false } = {}) {
  const auth = manager(); const value = auth.read();
  if (!value) throw new Error('缺少本人授权。登录 Gemini App 后，由本人明确同意执行 connect --consent-local-auth。');
  if (value.needsReconnect) throw new Error('Google 已拒绝授权；停止自动重试，需要本人重新登录并连接。');
  const token = await auth.token();
  const current = auth.read();
  const { googleJson } = await import('../runtime/scripts/google-json.mjs');
  const target = new URL('https://oauth2.googleapis.com/tokeninfo'); target.searchParams.set('access_token', token);
  const result = await googleJson(target.href, { method: 'GET' });
  const expiry = Number(result.data?.exp) * 1000;
  if (result.status !== 200 || result.data?.aud !== current.clientId || typeof result.data?.sub !== 'string' || !result.data.sub || !Number.isFinite(expiry) || expiry < Date.now() + 30_000 || (current.accountId && result.data.sub !== current.accountId)) throw new Error('Google 未通过账号、客户端或有效期校验。不会覆盖现有授权。');
  if (repair && !current.accountId) writePrivateJson(oauth, { ...current, accountId: result.data.sub, expiresAt: expiry });
  return { verifiedByGoogle: true, accountMatched: current.accountId ? true : null, expiresInSeconds: Math.floor((expiry - Date.now()) / 1000) };
}

export async function doctor({ repair = false, installDeps = false, verifyAuth = false, smoke = false } = {}) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  line(checks, 'node', major >= 22, process.versions.node, major < 22 ? '安装 Node.js 22 或更新版本；不会自动修改全局运行环境。' : undefined);
  line(checks, 'platform', process.platform === 'darwin' && process.arch === 'arm64', `${process.platform}/${process.arch}`, process.platform !== 'darwin' || process.arch !== 'arm64' ? '本包目前只验证 macOS Apple Silicon。' : undefined);
  try { const report = verifyManifest(); line(checks, 'package_integrity', true, report); } catch (error) { line(checks, 'package_integrity', false, error.message); return { ready: false, checks }; }
  let stateReady = false;
  try {
    if (repair) ensurePrivateDirectory(stateDirectory);
    else { const stat = fs.lstatSync(stateDirectory); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw new Error('状态目录权限不安全。'); }
    stateReady = true; line(checks, 'private_state', true, '本机独立状态目录，未安装 Skill 或修改全局配置。');
  } catch { line(checks, 'private_state', false, '缺少专用私有状态目录或权限不安全。', 'doctor --repair'); }
  let app;
  try { app = findAppBinary(); verifiedBinary(app); line(checks, 'gemini_app', true, VERIFIED_APP_VERSION); } catch (error) { line(checks, 'gemini_app', false, error.message); }
  const claude = findClaude(); line(checks, 'claude_code', !!claude, claude ? '找到可执行文件' : '未找到 claude', claude ? undefined : '安装官方 Claude Code，或设置 ARGON_CLAUDE_BIN；本包不会自行下载并运行未知安装器。');
  let proxy;
  try { proxy = await detectProxy(); line(checks, 'network_route_config', true, proxy); } catch (error) { line(checks, 'network_route_config', false, error.message); }
  if (repair && stateReady) {
    const configuration = { ...settings, ...(proxy ? { ARGON_PROXY: proxy } : {}), ...(claude ? { ARGON_CLAUDE_BIN: claude } : {}), ...(app ? { ARGON_APP_BINARY: app } : {}), ARGON_PORT: process.env.ARGON_PORT || '18185' };
    if (!/^\d+$/.test(configuration.ARGON_PORT) || Number(configuration.ARGON_PORT) < 1024 || Number(configuration.ARGON_PORT) > 65535) throw new Error('ARGON_PORT 必须是 1024–65535。');
    writePrivateJson(path.join(stateDirectory, 'settings.json'), configuration);
    for (const [key, value] of Object.entries(configuration)) if (['ARGON_PROXY', 'ARGON_CLAUDE_BIN', 'ARGON_APP_BINARY', 'ARGON_PORT'].includes(key)) process.env[key] = value;
    const tokenFile = path.join(stateDirectory, 'gateway-token');
    if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  }
  try { const filename = path.join(stateDirectory, 'gateway-token'); checkPrivateFile(filename); if (!/^[a-f0-9]{64}$/.test(fs.readFileSync(filename, 'utf8').trim())) throw new Error(); line(checks, 'gateway_token', true, '已配置独立本机口令（不显示值）。'); } catch { line(checks, 'gateway_token', false, '本机口令缺失、损坏或权限不安全。', '缺失可通过 doctor --repair 补齐；已有损坏文件不会静默覆盖。'); }
  if (installDeps && !dependencyReady() && major >= 22) {
    const code = await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtime });
    if (code !== 0) line(checks, 'dependency_install', false, 'npm ci 失败；未安装全局软件。');
  }
  line(checks, 'dependencies', dependencyReady(), dependencyReady() ? '包内依赖已就绪' : '缺少包内依赖', dependencyReady() ? undefined : 'doctor --repair --install-deps（只在本包 runtime 中安装锁定依赖）');
  const auth = manager().status(); line(checks, 'credential_file', auth.configured && !auth.needsReconnect, auth, auth.configured && !auth.needsReconnect ? undefined : '本人确认后 connect --consent-local-auth；不要借用他人的授权文件。');
  if (verifyAuth) { try { line(checks, 'google_credential_verification', true, await verifyAuthorization({ repair })); } catch (error) { line(checks, 'google_credential_verification', false, error.message); } }
  if (smoke && checks.every(check => check.status === 'ok')) {
    try {
      const { nativeQuery, responseText } = await import('../runtime/scripts/native-client.mjs');
      const result = await nativeQuery('Reply exactly: ARGON_SKILL_OK', { timeoutMs: 45_000 });
      if (responseText(result).trim() !== 'ARGON_SKILL_OK') throw new Error('收到回复，但未通过固定标记验证。');
      line(checks, 'live_model_smoke', true, { elapsedMs: result.elapsedMs, note: '仅一次真实模型调用；实际额度未知。' });
    } catch (error) { line(checks, 'live_model_smoke', false, error.message); }
  }
  return { ready: checks.every(check => check.status === 'ok'), liveVerified: checks.some(check => check.name === 'live_model_smoke' && check.status === 'ok'), checks };
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help') {
    console.log('Gemini Argon Skill（实验版，macOS arm64）\n\nnode scripts/argon.mjs doctor [--repair] [--install-deps] [--verify-auth] [--smoke]\nnode scripts/argon.mjs connect --consent-local-auth\nnode scripts/argon.mjs install-command [--configure-path]\nnode scripts/argon.mjs chat [-- <Claude Code 参数>]\n\n不安装 Skill，不修改 Codex/Claude 全局设置。install-command 创建本人 claude-argon 命令及固定运行目录；--configure-path 必要时备份并追加本人 .zprofile。connect 需本人确认 macOS 钥匙串弹窗；--smoke 会用本人额度发一次真实请求。'); return;
  }
  if (command === 'doctor') {
    for (const arg of args) if (!['--repair', '--install-deps', '--verify-auth', '--smoke'].includes(arg)) throw new Error('未知 doctor 参数。');
    const report = await doctor({ repair: args.includes('--repair'), installDeps: args.includes('--install-deps'), verifyAuth: args.includes('--verify-auth'), smoke: args.includes('--smoke') });
    console.log(JSON.stringify(report, null, 2)); if (!report.ready) process.exitCode = 1; return;
  }
  if (command === 'connect') {
    if (args.length !== 1 || args[0] !== '--consent-local-auth') throw new Error('首次连接须由本人明确同意读取 Gemini App 专用授权：connect --consent-local-auth。不要把密码发到聊天里。');
    verifyManifest(); if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('只支持已验证的 macOS arm64。');
    verifiedBinary(); ensurePrivateDirectory(stateDirectory);
    process.env.ARGON_PROXY = await detectProxy();
    const { importAppAuth } = await import('../runtime/scripts/import-app-auth.mjs');
    const result = await importAppAuth({ destination: oauth });
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (command === 'chat') {
    const report = await doctor();
    if (!report.ready) { console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return; }
    const forwarded = args[0] === '--' ? args.slice(1) : args;
    process.exitCode = await run(process.execPath, [path.join(runtime, 'scripts/claude-argon.mjs'), ...forwarded]); return;
  }
  if (command === 'install-command') {
    if (args.some(arg => arg !== '--configure-path') || args.length > 1) throw new Error('用法：install-command [--configure-path]');
    const report = await doctor();
    if (!report.ready) { console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return; }
    const { installCommand } = await import('./install-command.mjs');
    console.log(JSON.stringify(await installCommand({ skillDirectory: skillRoot, stateDirectory, configurePath: args.includes('--configure-path') }), null, 2)); return;
  }
  throw new Error('未知命令。使用 help 查看用法。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main().catch(error => { console.error(JSON.stringify({ ok: false, message: error.message })); process.exitCode = 1; });
