import { findAppBinary } from './portable-template.mjs';
import './portable-config.mjs';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

// Read-only evidence for Gemini 1.128.14.1166 (arm64). The native OAuth
// constructor at 0x100879610 loads this client ID, then calls 0x1008794bc.
// That helper reads 35 bytes at VM 0x10aa4b380 and XORs each with 0x5a.
// Pin the complete artifact: do not guess offsets after an App update.
const VERIFIED_SHA256 = '8cd89234b23182234e8e211e1449ae44e0a831b2185e98f4d1371a83c66f8964';
const CLIENT_ID_OFFSET = 165769760;
const SECRET_OFFSET = 178566016;
const SECRET_LENGTH = 35;

export function nativeClientConfig(clientId, { binaryPath = findAppBinary() } = {}) {
  const stat = fs.lstatSync(binaryPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < SECRET_OFFSET + SECRET_LENGTH || stat.size > 512 * 1024 * 1024) throw new Error('Gemini 原生客户端配置文件不匹配；未读取未知版本的客户端参数。');
  const binary = fs.readFileSync(binaryPath);
  if (createHash('sha256').update(binary).digest('hex') !== VERIFIED_SHA256) throw new Error('Gemini 安装包版本已变化，需要先验证新的原生客户端配置；未猜测或保存参数。');
  if (typeof clientId !== 'string' || !clientId.endsWith('.apps.googleusercontent.com') || !binary.subarray(CLIENT_ID_OFFSET, CLIENT_ID_OFFSET + clientId.length).equals(Buffer.from(clientId)) || binary[CLIENT_ID_OFFSET + clientId.length] !== 0) throw new Error('Gemini 授权账号使用的客户端与已验证安装包不匹配；未导入。');
  const decoded = Buffer.alloc(SECRET_LENGTH);
  try {
    for (let index = 0; index < SECRET_LENGTH; index++) decoded[index] = binary[SECRET_OFFSET + index] ^ 0x5a;
    const clientSecret = decoded.toString('ascii');
    if (!/^GOCSPX-[A-Za-z0-9_-]{28}$/.test(clientSecret)) throw new Error('Gemini 内置客户端配置结构不匹配；未导入。');
    return { clientId, clientSecret };
  } finally { decoded.fill(0); }
}
