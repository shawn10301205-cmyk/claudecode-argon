import { ensurePrivateDirectory } from './portable-state.mjs';
import './portable-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { googleJson } from './google-json.mjs';

export const STATE_DIRECTORY = process.env.ARGON_STATE_DIR || path.join(process.env.HOME, 'Library/Application Support/gemini-argon-skill');
export const OAUTH_FILE = path.join(STATE_DIRECTORY, 'oauth.json');
const ENDPOINTS = new Set(['https://www.googleapis.com/oauth2/v4/token', 'https://oauth2.googleapis.com/token']);
const fingerprint = token => createHash('sha256').update(token).digest('hex');

export class AuthError extends Error {
  constructor(code, message, httpStatus = 401) { super(message); this.code = code; this.httpStatus = httpStatus; }
}

export function writePrivateJson(filename, data) {
  const directory = path.dirname(filename);
  ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

export function validateCredential(value) {
  if (value?.version !== 1 || !ENDPOINTS.has(value.endpoint) || typeof value.clientId !== 'string' || !value.clientId.endsWith('.apps.googleusercontent.com') || typeof value.refreshToken !== 'string' || !value.refreshToken || value.refreshToken.length > 8192 || typeof value.clientSecret !== 'string' || !value.clientSecret || value.clientSecret.length > 512) throw new AuthError('invalid_credentials', '本机续期授权缺少必要字段，需要本人重新连接。');
  const accessToken = value.accessToken ?? '';
  const expiresAt = value.expiresAt ?? 0;
  if (typeof accessToken !== 'string' || accessToken.length > 8192 || !Number.isFinite(expiresAt) || (value.accountId != null && (typeof value.accountId !== 'string' || !value.accountId))) throw new AuthError('invalid_credentials', '本机授权结构不正确。');
  return { ...value, accessToken, expiresAt: accessToken ? expiresAt : 0 };
}

export class CredentialManager {
  constructor({ filename = OAUTH_FILE, transport = googleJson, now = () => Date.now(), skewMs = 300_000, onEvent = () => {} } = {}) {
    this.filename = filename; this.transport = transport; this.now = now; this.skewMs = skewMs; this.onEvent = onEvent;
    this.inflight = null; this.timer = null; this.watcher = null; this.snapshot = null; this.lastError = null; this.nextRefreshAt = null;
  }

  read() {
    let stat;
    try { stat = fs.lstatSync(this.filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new AuthError('unsafe_credentials', '本机 Gemini 凭据文件必须仅当前用户可读写，且不能是符号链接。');
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.filename, 'utf8')); } catch { throw new AuthError('invalid_credentials', '本机 Gemini 凭据文件损坏，需要重新导入。'); }
    return validateCredential(parsed);
  }

  status() {
    try {
      const credential = this.read();
      return { configured: !!credential, canRefresh: !!credential && !credential.needsReconnect,
        expiresInSeconds: credential ? Math.max(0, Math.floor((credential.expiresAt - this.now()) / 1000)) : this.snapshot ? Math.max(0, Math.floor((this.snapshot.expiresAt - this.now()) / 1000)) : null,
        refreshInProgress: !!this.inflight, needsReconnect: !!credential?.needsReconnect,
        lastRefreshAt: credential?.lastRefreshAt || null, nextRefreshAt: this.nextRefreshAt, lastError: this.lastError };
    } catch (error) { return { configured: false, canRefresh: false, needsReconnect: true, refreshInProgress: !!this.inflight, lastError: error.code || 'credential_read_failed' }; }
  }

  async token(snapshotToken) {
    const credential = this.read();
    if (credential) {
      if (credential.needsReconnect) throw new AuthError('needs_reconnect', 'Gemini 授权已失效，需要重新导入本人 App 的授权；网关口令没有失效。');
      if (credential.expiresAt > this.now() + this.skewMs) return credential.accessToken;
      return this.refresh();
    }
    if (!snapshotToken) throw new AuthError('missing_credentials', '尚未导入 Gemini 续期凭据。');
    const hash = fingerprint(snapshotToken);
    if (!this.snapshot || this.snapshot.fingerprint !== hash) {
      const target = new URL('https://oauth2.googleapis.com/tokeninfo'); target.searchParams.set('access_token', snapshotToken);
      let result;
      try { result = await this.transport(target.href, { method: 'GET' }); }
      catch { throw new AuthError('oauth_transport', '暂时无法核验 Gemini 凭据，请检查网络。', 503); }
      if (result.status !== 200 || !Number.isFinite(Number(result.data.exp))) throw new AuthError('missing_refresh_credentials', 'Gemini 短期凭据已失效，尚未导入可自动续期的授权。');
      this.snapshot = { fingerprint: hash, expiresAt: Number(result.data.exp) * 1000 };
    }
    if (this.snapshot.expiresAt <= this.now() + 30_000) throw new AuthError('missing_refresh_credentials', 'Gemini 短期凭据即将失效，尚未导入续期授权。');
    return snapshotToken;
  }

  async refresh({ rejectedToken, explicit = false } = {}) {
    if (this.inflight) return this.inflight;
    const credential = this.read();
    if (!credential) throw new AuthError('missing_refresh_credentials', 'Gemini 凭据已被拒绝，尚未导入续期授权。');
    if (credential.needsReconnect && !explicit) throw new AuthError('needs_reconnect', 'Gemini 授权需要重新连接，已停止重复刷新。');
    if (rejectedToken && credential.accessToken !== rejectedToken && credential.expiresAt > this.now() + 30_000) return credential.accessToken;
    this.inflight = (async () => {
      const form = { grant_type: 'refresh_token', client_id: credential.clientId, refresh_token: credential.refreshToken };
      if (credential.clientSecret) form.client_secret = credential.clientSecret;
      let result;
      try { result = await this.transport(credential.endpoint, { method: 'POST', form }); }
      catch { throw new AuthError('oauth_transport', 'Google 续期连接失败，请检查网络；没有删除原凭据。', 503); }
      if (result.status !== 200) {
        const permanent = ['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied'].includes(result.data?.error);
        if (permanent) {
          writePrivateJson(this.filename, { ...credential, needsReconnect: true });
          throw new AuthError('needs_reconnect', 'Google 已拒绝续期授权，需要重新导入本人 App 的授权；已停止重复重试。');
        }
        throw new AuthError('oauth_service', 'Google 续期服务暂不可用，原凭据保持不变。', 503);
      }
      const expiresIn = Number(result.data.expires_in);
      if (typeof result.data.access_token !== 'string' || !result.data.access_token || !Number.isFinite(expiresIn) || expiresIn < 30 || expiresIn > 31_536_000) throw new AuthError('invalid_refresh_response', 'Google 返回了无法验证的续期结果，原凭据保持不变。', 502);
      const target = new URL('https://oauth2.googleapis.com/tokeninfo'); target.searchParams.set('access_token', result.data.access_token);
      let verified;
      try { verified = await this.transport(target.href, { method: 'GET' }); } catch { throw new AuthError('oauth_transport', 'Google 凭据核验连接失败，原凭据保留。', 503); }
      const exp = Number(verified.data?.exp) * 1000;
      if (verified.status !== 200 || verified.data?.aud !== credential.clientId || typeof verified.data?.sub !== 'string' || !verified.data.sub || (credential.accountId && verified.data.sub !== credential.accountId) || !Number.isFinite(exp) || exp <= this.now() + 30000 || exp > this.now() + 31536000000) throw new AuthError('identity_mismatch', '续期后的账号、客户端或有效期不匹配，原凭据保留。');
      const updated = { accountId: verified.data.sub, ...credential, accessToken: result.data.access_token, expiresAt: Math.min(exp, this.now() + expiresIn * 1000), lastRefreshAt: this.now(), needsReconnect: false };
      if (typeof result.data.refresh_token === 'string' && result.data.refresh_token) updated.refreshToken = result.data.refresh_token;
      writePrivateJson(this.filename, updated); this.lastError = null;
      this.onEvent({ event: 'credential_refreshed', expiresInSeconds: expiresIn });
      this.schedule(); return updated.accessToken;
    })();
    try { return await this.inflight; }
    catch (error) { this.lastError = error.code || 'refresh_failed'; throw error; }
    finally { this.inflight = null; }
  }

  reject(token) {
    const credential = this.read();
    if (credential && credential.accessToken === token) writePrivateJson(this.filename, { ...credential, needsReconnect: true });
    this.lastError = 'credential_rejected'; this.schedule();
    throw new AuthError('credential_rejected', '更新后的 Gemini 凭据仍被拒绝，已停止自动重试，请重新连接授权。');
  }

  schedule() {
    if (this.timer) clearTimeout(this.timer); this.timer = null; this.nextRefreshAt = null;
    let credential; try { credential = this.read(); } catch { return; }
    if (!credential || credential.needsReconnect) return;
    const delay = Math.min(2_147_000_000, Math.max(1000, credential.expiresAt - this.now() - this.skewMs));
    this.nextRefreshAt = this.now() + delay;
    this.timer = setTimeout(() => this.refresh().catch(error => {
      this.onEvent({ event: 'credential_refresh_failed', code: error.code || 'unknown' });
      if (error.httpStatus >= 500) {
        this.timer = setTimeout(() => this.schedule(), 60_000); this.timer.unref?.();
      }
    }), delay); this.timer.unref?.();
  }

  start() {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 }); this.schedule();
    this.watcher = fs.watch(path.dirname(this.filename), (_event, name) => { if (String(name) === path.basename(this.filename)) this.schedule(); });
    this.watcher.unref?.();
  }

  stop() { if (this.timer) clearTimeout(this.timer); this.watcher?.close(); }
}

export const credentials = new CredentialManager({ onEvent: event => console.log(JSON.stringify(event)) });
