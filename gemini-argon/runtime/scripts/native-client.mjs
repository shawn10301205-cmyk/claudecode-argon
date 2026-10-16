import './portable-config.mjs';
import fs from 'node:fs';
import tls from 'node:tls';
import http2 from 'node:http2';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { parseFields } from './inspect-protobuf.mjs';
import { tunnel } from './proxy-tunnel.mjs';
import { credentials } from './auth-store.mjs';
export { tunnel } from './proxy-tunnel.mjs';

import { createTemplate } from './portable-template.mjs';
const HOST = 'robinfrontend-pa.googleapis.com';

export function varint(value) {
  let n = BigInt(value); const out = [];
  do { const x = Number(n & 127n); n >>= 7n; out.push(x | (n ? 128 : 0)); } while (n);
  return Buffer.from(out);
}

function replaceAtPath(bytes, path, replacement) {
  let found = false;
  const result = Buffer.concat(parseFields(bytes).map(field => {
    if (field.number !== path[0] || field.wire !== 2) return bytes.subarray(field.start, field.end);
    found = true;
    const value = path.length === 1 ? replacement : replaceAtPath(field.value, path.slice(1), replacement);
    return Buffer.concat([varint((field.number * 8) + 2), varint(value.length), value]);
  }));
  if (!found) throw new Error('Native request template no longer matches the observed schema');
  return result;
}

export function grpcFrames(bytes, encoding) {
  const frames = []; let pos = 0;
  while (pos < bytes.length) {
    if (pos + 5 > bytes.length) throw new Error('Truncated gRPC frame header');
    const compressed = bytes[pos]; const size = bytes.readUInt32BE(pos + 1);
    if (size > 16 * 1024 * 1024 || pos + size + 5 > bytes.length) throw new Error('Invalid gRPC frame size');
    let body = bytes.subarray(pos + 5, pos + 5 + size);
    if (compressed) {
      if (compressed !== 1 || encoding !== 'gzip') throw new Error('Unsupported gRPC compression');
      body = gunzipSync(body, { maxOutputLength: 16 * 1024 * 1024 });
    }
    frames.push(body); pos += size + 5;
  }
  return frames;
}

export function fieldAt(bytes, path) {
  for (const number of path) {
    const field = parseFields(bytes).find(field => field.number === number && field.wire === 2);
    if (!field) return undefined;
    bytes = field.value;
  }
  return bytes;
}

export function responseText(result) {
  if (result.status !== 200 || result.grpcStatus !== '0') {
    const error = new Error(result.grpcStatus === '16' ? 'Native App credential expired or was rejected; check renewal status or reconnect the local authorization.'
      : /location/i.test(result.grpcMessage) ? 'Google rejected the current network location. Check that the App and bridge use the same working route.'
      : `Native upstream failed (HTTP ${result.status}, gRPC ${result.grpcStatus || 'missing'}).`);
    error.upstreamCode = result.grpcStatus; throw error;
  }
  let text = '';
  for (const message of grpcFrames(result.body, result.encoding)) {
    const value = fieldAt(message, [1003, 1, 1, 2, 1]);
    if (value) {
      const candidate = value.toString('utf8');
      if (!Buffer.from(candidate).equals(value)) throw new Error('Invalid UTF-8 answer');
      // This field is the cumulative answer, not a delta. Later frames replace it.
      text = candidate;
    }
  }
  if (!text.trim()) throw new Error('The native upstream did not supply a recognized text answer');
  return text;
}

function frame(bytes) {
  const head = Buffer.alloc(5); head.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([head, bytes]);
}

export function loadTemplate() { return createTemplate(); }

export function requestBody(template, prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 250_000) throw new Error('Invalid prompt');
  const frames = grpcFrames(Buffer.from(template.bodyBase64, 'base64'));
  if (frames.length !== 3) throw new Error('Unexpected native request frame count');
  frames[0] = replaceAtPath(frames[0], [1000, 1001, 1, 1, 1], Buffer.from(prompt));
  frames[1] = replaceAtPath(frames[1], [1007, 1], Buffer.from(prompt));
  frames[0] = replaceAtPath(frames[0], [1000, 2, 1], Buffer.from(randomUUID().toUpperCase()));
  frames[0] = replaceAtPath(frames[0], [1000, 1001, 1, 16, 1004, 12, 1], Buffer.from(randomUUID().toUpperCase()));
  return Buffer.concat(frames.map(frame));
}

export async function nativeQueryRaw(prompt, { timeoutMs = 90_000, signal, template = loadTemplate(), accessToken } = {}) {
  if (signal?.aborted) throw new Error('Native query cancelled');
  const url = new URL(template.url);
  if (url.hostname !== HOST || url.pathname !== '/assistant.mobile.robin.RobinService/ProcessQuery') throw new Error('Unrecognized native request target');
  const body = requestBody(template, prompt);
  const socket = await tunnel(process.env.ARGON_PROXY || 'direct', HOST);
  const secure = tls.connect({ socket, servername: HOST, ALPNProtocols: ['h2'], rejectUnauthorized: true });
  await new Promise((resolve, reject) => {
    secure.setTimeout(15_000, () => secure.destroy(new Error('Upstream TLS handshake timed out')));
    secure.once('secureConnect', () => { secure.setTimeout(0); resolve(); }); secure.once('error', reject);
  });
  if (secure.alpnProtocol !== 'h2') { secure.destroy(); throw new Error('Upstream did not negotiate HTTP/2'); }
  if (signal?.aborted) { secure.destroy(); throw new Error('Native query cancelled'); }
  const session = http2.connect(`https://${HOST}`, { createConnection: () => secure });
  const headers = { ':method': 'POST', ':path': url.pathname, 'content-type': 'application/grpc', te: 'trailers', 'grpc-accept-encoding': 'gzip', 'grpc-timeout': `${timeoutMs}m` };
  for (const [key, value] of template.headers) {
    const k = key.toLowerCase();
    if (['authorization', 'x-ios-bundle-identifier', 'x-server-token', 'accept-language', 'user-agent'].includes(k)) headers[k] = value;
  }
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const request = session.request(headers);
    let responseHeaders = {}, trailers = {}, size = 0; const chunks = [];
    const timer = setTimeout(() => fail(new Error('Native query timed out')), timeoutMs);
    const abort = () => fail(new Error('Native query cancelled'));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); request.close(); session.destroy(); };
    const fail = error => { cleanup(); reject(error); };
    signal?.addEventListener('abort', abort, { once: true });
    session.on('error', fail); request.on('error', fail);
    request.on('response', h => { responseHeaders = h; });
    request.on('trailers', h => { trailers = h; });
    request.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) return fail(new Error('Native response exceeds local limit')); chunks.push(chunk); });
    request.on('end', () => {
      const bytes = Buffer.concat(chunks); cleanup();
      resolve({ status: responseHeaders[':status'], grpcStatus: String(trailers['grpc-status'] ?? responseHeaders['grpc-status'] ?? ''), grpcMessage: String(trailers['grpc-message'] ?? responseHeaders['grpc-message'] ?? ''), encoding: responseHeaders['grpc-encoding'], body: bytes, elapsedMs: Math.round(performance.now() - started) });
    });
    request.end(body);
  });
}

export async function queryWithRenewal(prompt, { manager = credentials, send = nativeQueryRaw, template = loadTemplate(), ...options } = {}) {
  const snapshotToken = (template.headers.find(([key]) => key.toLowerCase() === 'authorization')?.[1] || '').replace(/^Bearer /, '');
  let accessToken = await manager.token(snapshotToken);
  if (options.signal?.aborted) throw new Error('Native query cancelled');
  let result = await send(prompt, { ...options, template, accessToken });
  if (result.status === 401 || result.grpcStatus === '16') {
    accessToken = await manager.refresh({ rejectedToken: accessToken });
    if (options.signal?.aborted) throw new Error('Native query cancelled');
    result = await send(prompt, { ...options, template, accessToken });
    if (result.status === 401 || result.grpcStatus === '16') manager.reject(accessToken);
  }
  return result;
}

export async function nativeQuery(prompt, options = {}) { return queryWithRenewal(prompt, options); }

