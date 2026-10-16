import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const VERIFIED_SHA256 = '8cd89234b23182234e8e211e1449ae44e0a831b2185e98f4d1371a83c66f8964';
export const VERIFIED_APP_VERSION = '1.128.14.1166';
export const SELECTOR_OFFSET = 168708882;
const SELECTOR_LENGTH = 13;
let cached;

export function findAppBinary() {
  const candidates = process.env.ARGON_APP_BINARY ? [process.env.ARGON_APP_BINARY] : [
    '/Applications/Gemini.app/Contents/MacOS/Gemini',
    path.join(os.homedir(), 'Applications/Gemini.app/Contents/MacOS/Gemini'),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('未找到 Gemini.app。请先安装、登录本人账号，或设置 ARGON_APP_BINARY。');
  return found;
}

export function verifiedBinary(binaryPath = findAppBinary()) {
  const stat = fs.lstatSync(binaryPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < SELECTOR_OFFSET + SELECTOR_LENGTH || stat.size > 512 * 1024 * 1024) throw new Error('Gemini 安装文件不符合已验证格式。');
  const key = `${binaryPath}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (cached?.key === key) return cached.bytes;
  const bytes = fs.readFileSync(binaryPath);
  if (createHash('sha256').update(bytes).digest('hex') !== VERIFIED_SHA256) throw new Error(`Gemini App 版本尚未支持；本包只验证了 macOS arm64 ${VERIFIED_APP_VERSION}，不会猜测参数。`);
  cached = { key, bytes };
  return bytes;
}

function vint(value) {
  let n = BigInt(value); const bytes = [];
  do { const b = Number(n & 127n); n >>= 7n; bytes.push(b | (n ? 128 : 0)); } while (n);
  return Buffer.from(bytes);
}

export function message(fields) {
  return Buffer.concat(fields.map(([number, value]) => {
    if (typeof value === 'number') return Buffer.concat([vint(number * 8), vint(value)]);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([vint(number * 8 + 2), vint(bytes.length), bytes]);
  }));
}

function frame(bytes) {
  const header = Buffer.alloc(5); header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

// Build from protocol field numbers and the verified installed App's selector.
// No capture, bearer token, account/device identifier, or server token is used.
export function createTemplate({ binaryPath, selector } = {}) {
  if (!selector) selector = verifiedBinary(binaryPath).subarray(SELECTOR_OFFSET, SELECTOR_OFFSET + SELECTOR_LENGTH);
  if (!Buffer.isBuffer(selector) || selector.length !== SELECTOR_LENGTH) throw new Error('Invalid native model selector');
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const context = message([
    [3, message([[1, VERIFIED_APP_VERSION], [6, 0], [9, 'prod']])],
    [4, 21], [5, 1], [7, locale], [10, message([[1, 4]])],
    [19, message([[1, selector]])], [20, 2],
  ]);
  const input = message([
    [1, message([[1, 'ARGON_PLACEHOLDER']])], [4, message([[1, ''], [2, ''], [3, '']])], [5, 1],
    [6, message([[1, 0]])], [8, message([[1, 1]])],
    [16, message([[1004, message([[4, message([[1, selector]])], [12, message([[1, randomUUID().toUpperCase()]])]])]])],
    [17, 2], [18, 1], [47, 8], [48, 4], [56, 1],
  ]);
  const start = message([[1000, message([
    [1, context], [2, message([[1, randomUUID().toUpperCase()]])],
    [1001, message([[1, input]])], [1004, ''],
  ])]]);
  const body = Buffer.concat([frame(start), frame(message([[1007, message([[1, 'ARGON_PLACEHOLDER']])]])), frame(message([[1007, message([[2, '']])]]))]);
  return {
    url: 'https://robinfrontend-pa.googleapis.com/assistant.mobile.robin.RobinService/ProcessQuery',
    headers: [['x-ios-bundle-identifier', 'com.google.GeminiMacOS'], ['accept-language', locale]],
    bodyBase64: body.toString('base64'),
  };
}
