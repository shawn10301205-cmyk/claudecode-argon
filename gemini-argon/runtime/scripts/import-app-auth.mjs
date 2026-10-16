import './portable-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDecipheriv } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseFields } from './inspect-protobuf.mjs';
import { OAUTH_FILE, writePrivateJson, validateCredential } from './auth-store.mjs';
import { googleJson } from './google-json.mjs';
import { nativeClientConfig } from './native-client-config.mjs';

const MAGIC = Buffer.from('2ebafeca2ebafeca', 'hex');
const APP_AUTH_FILE = path.join(process.env.HOME, 'Library/Application Support/com.google.GeminiMacOS/Data/user1/auth');
const ENDPOINT = 'https://www.googleapis.com/oauth2/v4/token';

export function oauthFailureSummary(result) {
  const known = new Set(['invalid_client', 'invalid_grant', 'unauthorized_client', 'invalid_request', 'unsupported_grant_type', 'access_denied', 'temporarily_unavailable', 'server_error']);
  const code = known.has(result?.data?.error) ? result.data.error : 'request_failed';
  const status = Number.isInteger(result?.status) && result.status >= 100 && result.status <= 599 ? result.status : 0;
  // Descriptions can contain provider data. Classify only a known failure and
  // never return the description, request form, or unknown error value.
  const missingClientSecret = code === 'invalid_request' && typeof result?.data?.error_description === 'string' && /client_secret.*(?:missing|required)|(?:missing|required).*client_secret/i.test(result.data.error_description);
  return { status, code, missingClientSecret };
}

function field(fields, number, wire) { return fields.find(item => item.number === number && item.wire === wire)?.value; }

export function decodeKeystore(output) {
  const raw = Buffer.isBuffer(output) ? output : Buffer.from(output);
  const candidates = [raw];
  if (raw.at(-1) === 10) candidates.push(raw.subarray(0, -1));
  const text = raw.toString('utf8').trim();
  if (/^(?:0x)?[a-f0-9]+$/i.test(text) && text.replace(/^0x/i, '').length % 2 === 0) candidates.push(Buffer.from(text.replace(/^0x/i, ''), 'hex'));
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0) candidates.push(Buffer.from(text, 'base64'));
  for (const candidate of candidates) {
    try {
      const root = parseFields(candidate);
      const keys = root.filter(item => item.number === 2 && item.wire === 2).map(item => {
        const data = parseFields(item.value);
        return { id: Number(field(data, 1, 0)), version: Number(field(data, 2, 0)), key: field(data, 4, 2) };
      });
      if (keys.length && keys.every(item => Number.isInteger(item.id) && Number.isInteger(item.version) && item.key?.length === 32)) return keys;
    } catch { /* A different security(1) output encoding may be in use. */ }
  }
  throw new Error('无法识别 Gemini 专用密钥格式；未导入任何凭据。');
}

export function decryptNativeCredential(encoded, keystoreOutput) {
  if (!Buffer.isBuffer(encoded) || encoded.length < 40 || encoded.length > 128 * 1024 || !encoded.subarray(0, 8).equals(MAGIC)) throw new Error('Gemini 本机授权文件格式不匹配。');
  const preambleLength = encoded.readUInt32LE(8);
  if (!preambleLength || preambleLength > 512 || 12 + preambleLength + 16 > encoded.length) throw new Error('Gemini 授权文件头无效。');
  const preambleBytes = encoded.subarray(12, 12 + preambleLength);
  const preamble = parseFields(preambleBytes);
  const id = Number(field(preamble, 1, 0)), version = Number(field(preamble, 2, 0));
  const format = Number(field(preamble, 3, 0)), nonce = field(preamble, 4, 2);
  const ciphertextLength = Number(field(preamble, 5, 0));
  if (id !== 1 || format !== 1 || nonce?.length !== 12 || ciphertextLength !== encoded.length - 12 - preambleLength) throw new Error('Gemini 授权文件的加密参数不匹配。');
  const key = decodeKeystore(keystoreOutput).find(item => item.id === id && item.version === version)?.key;
  if (!key) throw new Error('未找到与 Gemini 本机授权文件匹配的专用密钥。');
  const ciphertext = encoded.subarray(12 + preambleLength, -16), tag = encoded.subarray(-16);
  let plain;
  for (const aad of [Buffer.alloc(0), preambleBytes, encoded.subarray(0, 12 + preambleLength)]) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(aad); decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]); break;
    } catch { /* Fail closed unless the authentication tag verifies. */ }
  }
  if (!plain) throw new Error('Gemini 授权文件认证校验失败；未保存明文或修改 App 数据。');
  try {
    const fields = parseFields(plain);
    const refreshToken = field(fields, 4, 2)?.toString('utf8');
    const idToken = field(fields, 8, 2)?.toString('utf8');
    const accountId = field(fields, 1, 2)?.toString('utf8');
    if (!refreshToken || refreshToken.length > 8192 || !idToken || !accountId) throw new Error('missing_fields');
    const pieces = idToken.split('.'); if (pieces.length !== 3) throw new Error('invalid_id_token');
    const claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || String(claims.sub) !== accountId) throw new Error('identity_mismatch');
    const clientId = typeof claims.aud === 'string' ? claims.aud : Array.isArray(claims.aud) && claims.aud.includes(claims.azp) ? claims.azp : null;
    if (!clientId?.endsWith('.apps.googleusercontent.com')) throw new Error('invalid_client');
    return { clientId, refreshToken, accountId };
  } catch { throw new Error('Gemini 授权记录结构或账号身份不匹配；未导入。'); }
  finally { plain.fill(0); }
}

export async function importAppAuth({ keystoreFile, destination = OAUTH_FILE, transport = googleJson, authFile = APP_AUTH_FILE, readClientConfig = nativeClientConfig } = {}) {
  // Fail before a Keychain prompt when the supported App/auth file is absent.
  const { verifiedBinary } = await import('./portable-template.mjs'); verifiedBinary();
  const authStat = fs.lstatSync(authFile);
  if (!authStat.isFile() || authStat.isSymbolicLink() || (process.getuid && authStat.uid !== process.getuid())) throw new Error('本人 App 授权文件不安全或不存在。');
  let keyOutput;
  if (keystoreFile) {
    const source = path.resolve(keystoreFile), stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('导入密钥文件必须仅当前用户可读写，且不能是符号链接。');
    keyOutput = fs.readFileSync(source);
  } else {
    try {
      const result = await promisify(execFile)('/usr/bin/security', ['find-generic-password', '-s', 'Gemini Safe Storage', '-a', 'Gemini Keys', '-w'], { encoding: 'buffer', timeout: 600_000, maxBuffer: 65_536 });
      keyOutput = result.stdout;
    } catch { throw new Error('macOS 尚未允许读取 Gemini 专用密钥，请在系统钥匙串弹窗中确认后重试。'); }
  }
  let native;
  try { native = decryptNativeCredential(fs.readFileSync(authFile), keyOutput); }
  finally { keyOutput.fill(0); }
  return importNativeCredential(native, { destination, transport, readClientConfig });
}

export async function importNativeCredential(native, { destination = OAUTH_FILE, transport = googleJson, readClientConfig = nativeClientConfig } = {}) {
  if (typeof native?.clientId !== 'string' || typeof native?.refreshToken !== 'string' || !native.refreshToken || native.refreshToken.length > 8192 || typeof native?.accountId !== 'string' || !native.accountId) throw new Error('Gemini 授权记录不完整；未导入。');
  const client = readClientConfig(native.clientId);
  if (typeof client?.clientSecret !== 'string' || !client.clientSecret || client.clientSecret.length > 512) throw new Error('Gemini 原生客户端参数不完整；未发送或保存授权。');
  const form = { grant_type: 'refresh_token', client_id: native.clientId, client_secret: client.clientSecret, refresh_token: native.refreshToken };
  const refreshed = await transport(ENDPOINT, { method: 'POST', form });
  if (refreshed.status !== 200 || typeof refreshed.data?.access_token !== 'string' || !refreshed.data.access_token) {
    const failure = oauthFailureSummary(refreshed);
    throw new Error(`Google 没有接受导入的续期授权（HTTP ${failure.status}，${failure.code}${failure.missingClientSecret ? '，客户端参数缺少 client_secret' : ''}）；原网关凭据未改。`);
  }
  const tokeninfo = new URL('https://oauth2.googleapis.com/tokeninfo'); tokeninfo.searchParams.set('access_token', refreshed.data.access_token);
  const verified = await transport(tokeninfo.href, { method: 'GET' });
  const expiresAt = Number(verified.data?.exp) * 1000;
  if (verified.status !== 200 || String(verified.data?.sub) !== native.accountId || verified.data?.aud !== native.clientId || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000 || expiresAt > Date.now() + 31_536_000_000) throw new Error('Google 返回的新凭据与本人 Gemini 账号不匹配或已到期；未导入。');
  const credential = validateCredential({ version: 1, endpoint: ENDPOINT, clientId: native.clientId,
    clientSecret: client.clientSecret,
    accountId: native.accountId, refreshToken: refreshed.data.refresh_token || native.refreshToken, accessToken: refreshed.data.access_token,
    expiresAt, lastRefreshAt: Date.now(), needsReconnect: false });
  writePrivateJson(destination, credential);
  return { imported: true, verifiedByGoogle: true, expiresInSeconds: Math.max(0, Math.floor((credential.expiresAt - Date.now()) / 1000)), source: '本人 Gemini App 专用钥匙串与授权文件', passwordStored: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const arg = process.argv[2];
    if (arg && arg !== '--keystore-file') throw new Error('Usage: node scripts/import-app-auth.mjs [--keystore-file /private/path]');
    console.log(JSON.stringify(await importAppAuth({ keystoreFile: arg ? process.argv[3] : undefined }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
