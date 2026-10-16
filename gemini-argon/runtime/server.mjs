import { ensurePrivateDirectory, checkPrivateFile } from './scripts/portable-state.mjs';
import './scripts/portable-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { nativeQuery, responseText } from './scripts/native-client.mjs';
import { credentials, AuthError } from './scripts/auth-store.mjs';
import { prepareRequest, queryAssistant, messageEvents } from './scripts/tool-protocol.mjs';

export const MODEL = 'gemini-argon-app';
const stateDirectory = process.env.ARGON_STATE_DIR || path.join(process.env.HOME, 'Library/Application Support/gemini-argon-skill');
export const TOKEN_PATH = path.join(stateDirectory, 'gateway-token');
ensurePrivateDirectory(stateDirectory);
try { fs.writeFileSync(TOKEN_PATH, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
checkPrivateFile(TOKEN_PATH);
const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local gateway token');
const port = Number(process.env.ARGON_PORT || 18185);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local gateway port');
let running = 0;

function authorized(request) {
  const supplied = request.headers['x-api-key'] || (request.headers.authorization || '').replace(/^Bearer /i, '');
  if (typeof supplied !== 'string') return false;
  const value = Buffer.from(supplied); const expected = Buffer.from(token);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function promptFor(body) {
  return prepareRequest(body, MODEL).prompt;
}

async function readBody(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_048_576) throw new Error('Request exceeds 1 MB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (request, response) => {
  const id = randomUUID();
  if (!['127.0.0.1', 'localhost'].includes((request.headers.host || '').split(':')[0])) return json(response, 403, { type: 'error', error: { type: 'permission_error', message: 'Invalid local Host header' } });
  const target = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
  if (request.headers.origin) return json(response, 403, { type: 'error', error: { type: 'permission_error', message: 'Browser origins are not permitted' } });
  if (request.method === 'GET' && target === '/health') return json(response, 200, { status: 'ok', distribution: 'gemini-argon-skill-v1', instance: createHash('sha256').update(token).digest('hex'), model: MODEL, protocolVersion: 2, mode: 'experimental-client-tools', capabilities: { clientTools: true, nativeToolCalling: false, multimodal: false }, auth: credentials.status() });
  if (!authorized(request)) return json(response, 401, { type: 'error', error: { type: 'authentication_error', message: 'A local gateway token is required' } });
  if (request.method === 'GET' && target === '/v1/argon/auth/status') return json(response, 200, credentials.status());
  if (request.method === 'POST' && target === '/v1/argon/auth/refresh') {
    try { await credentials.refresh({ explicit: true }); return json(response, 200, credentials.status()); }
    catch (error) { return json(response, error.httpStatus || 502, { type: 'error', error: { type: error instanceof AuthError && error.httpStatus === 401 ? 'authentication_error' : 'api_error', message: error.message } }); }
  }
  if (request.method === 'GET' && target === '/v1/models') return json(response, 200, { data: [{ id: MODEL, type: 'model', display_name: 'Gemini App Argon' }], has_more: false });
  if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(target)) return json(response, 404, { type: 'error', error: { type: 'not_found_error', message: 'Unknown endpoint' } });
  let body, prepared;
  try {
    body = await readBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object');
    if (body.stream != null && typeof body.stream !== 'boolean') throw new Error('stream must be a boolean');
    prepared = prepareRequest(body, MODEL);
  }
  catch (error) { return json(response, 400, { type: 'error', error: { type: 'invalid_request_error', message: error.message } }); }
  if (target.endsWith('/count_tokens')) return json(response, 200, { input_tokens: Math.ceil(Buffer.byteLength(prepared.prompt) / 4) });
  if (running >= 2) return json(response, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'Local concurrency limit reached; retry later' } });
  running++;
  const started = performance.now(); const abort = new AbortController();
  const cancel = () => { if (!response.writableEnded) abort.abort(); };
  response.once('close', cancel);
  const keepalive = body.stream ? setInterval(() => {
    if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    response.write(': waiting for native Argon\n\n');
  }, 10_000) : null;
  try {
    const result = await queryAssistant(prepared, { signal: abort.signal,
      query: prompt => nativeQuery(prompt, { timeoutMs: 120_000, signal: abort.signal }), getText: responseText,
      onRepair: code => console.log(JSON.stringify({ event: 'tool_format_retry', id, code })) });
    const message = { id: `msg_${id.replaceAll('-', '')}`, type: 'message', role: 'assistant', model: MODEL, content: result.content, stop_reason: result.stop_reason, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    if (response.destroyed) return;
    if (keepalive) clearInterval(keepalive);
    if (!body.stream) json(response, 200, message);
    else {
      if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const event = (name, payload) => response.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
      for (const [name, payload] of messageEvents(message)) event(name, payload);
      response.end();
    }
    console.log(JSON.stringify({ event: 'completed', id, model: MODEL, elapsedMs: Math.round(performance.now() - started), http: result.upstream.status, grpc: result.upstream.grpcStatus,
      offeredTools: prepared.offeredTools, receivedToolResults: prepared.resultCount, emittedToolCalls: result.content.filter(block => block.type === 'tool_use').length, formatRepairs: result.formatRepairs }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'failed', id, elapsedMs: Math.round(performance.now() - started), code: error.code || error.upstreamCode || 'local' }));
    if (!response.destroyed) {
      const payload = { type: 'error', error: { type: error instanceof AuthError && error.httpStatus === 401 ? 'authentication_error' : 'api_error', message: error.message } };
      if (response.headersSent) response.end(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      else json(response, error.httpStatus || 502, payload);
    }
  } finally { if (keepalive) clearInterval(keepalive); response.off('close', cancel); running--; }
});
server.requestTimeout = 30_000; server.headersTimeout = 15_000;
server.listen(port, '127.0.0.1', () => { credentials.start(); console.log(JSON.stringify({ event: 'listening', host: '127.0.0.1', port, model: MODEL })); });
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => { credentials.stop(); server.close(() => process.exit(0)); });
