import './portable-config.mjs';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function readVarint(buffer, start) {
  let value = 0n;
  for (let i = start; i < buffer.length && i < start + 10; i++) {
    const byte = buffer[i];
    value |= BigInt(byte & 127) << BigInt((i - start) * 7);
    if (byte < 128) return [value, i + 1];
  }
  throw new Error('Invalid protobuf varint');
}

export function parseFields(buffer) {
  const fields = [];
  let pos = 0;
  while (pos < buffer.length) {
    const start = pos;
    const [tag, next] = readVarint(buffer, pos);
    pos = next;
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!number || number > 536870911) throw new Error('Invalid protobuf tag');
    let value;
    if (wire === 0) [value, pos] = readVarint(buffer, pos);
    else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (pos + size > buffer.length) throw new Error('Truncated fixed field');
      value = buffer.subarray(pos, pos + size);
      pos += size;
    } else if (wire === 2) {
      const [length, after] = readVarint(buffer, pos);
      if (length > BigInt(buffer.length - after)) throw new Error('Truncated field');
      pos = after;
      value = buffer.subarray(pos, pos + Number(length));
      pos += Number(length);
    } else throw new Error('Unsupported protobuf wire type');
    fields.push({ number, wire, value, start, end: pos });
  }
  return fields;
}

export function inspect(buffer, prefix = '', depth = 0) {
  if (depth > 7) return [];
  let fields;
  try { fields = parseFields(buffer); } catch { return []; }
  return fields.map((field, i) => {
    const path = `${prefix}${field.number}[${i}]`;
    if (!Buffer.isBuffer(field.value)) return { path, wire: field.wire, kind: 'integer' };
    const text = field.value.toString('utf8');
    const isText = Buffer.from(text).equals(field.value) && !/[\x00-\x08\x0b-\x1f]/.test(text);
    const category = /^ya29\./.test(text) ? 'oauth-access-token'
      : /^1\/\//.test(text) || /^1\/[A-Za-z0-9_-]{20,}/.test(text) ? 'possible-oauth-refresh-token'
      : /\.apps\.googleusercontent\.com$/.test(text) ? 'oauth-client-id'
      : /^https:\/\/www\.googleapis\.com\/auth\//.test(text) ? 'google-oauth-scope'
      : isText ? 'text-redacted' : 'bytes';
    const children = !isText && field.wire === 2 ? inspect(field.value, `${path}.`, depth + 1) : [];
    return { path, wire: field.wire, length: field.value.length, category, ...(children.length ? { children } : {}) };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: node scripts/inspect-protobuf.mjs <local-file>');
  const buffer = fs.readFileSync(input);
  console.log(JSON.stringify({ bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), fields: inspect(buffer) }, null, 2));
}
