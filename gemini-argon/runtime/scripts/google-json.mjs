import './portable-config.mjs';
import tls from 'node:tls';
import http2 from 'node:http2';
import { tunnel } from './proxy-tunnel.mjs';

const ALLOWED_HOSTS = new Set(['www.googleapis.com', 'oauth2.googleapis.com']);
const ALLOWED_PATHS = new Set(['/oauth2/v4/token', '/token', '/tokeninfo', '/oauth2/v1/tokeninfo']);

export async function googleJson(url, { method = 'POST', form, timeoutMs = 20_000 } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.port || target.username || target.password || !ALLOWED_HOSTS.has(target.hostname) || !ALLOWED_PATHS.has(target.pathname)) throw new Error('Unrecognized Google authorization endpoint');
  const socket = await tunnel(process.env.ARGON_PROXY || 'direct', target.hostname);
  const secure = tls.connect({ socket, servername: target.hostname, ALPNProtocols: ['h2'], rejectUnauthorized: true });
  await new Promise((resolve, reject) => {
    secure.setTimeout(timeoutMs, () => secure.destroy(new Error('Google authorization TLS timeout')));
    secure.once('secureConnect', () => { secure.setTimeout(0); resolve(); }); secure.once('error', reject);
  });
  if (secure.alpnProtocol !== 'h2') { secure.destroy(); throw new Error('Google authorization HTTP/2 unavailable'); }
  const session = http2.connect(target.origin, { createConnection: () => secure });
  return new Promise((resolve, reject) => {
    let settled = false; let status = 0; let size = 0; const chunks = [];
    const headers = { ':method': method, ':path': target.pathname + target.search, accept: 'application/json' };
    const payload = form ? new URLSearchParams(form).toString() : '';
    if (payload) headers['content-type'] = 'application/x-www-form-urlencoded';
    const request = session.request(headers);
    const cleanup = () => { clearTimeout(timer); request.close(); session.destroy(); };
    const fail = () => { if (settled) return; settled = true; cleanup(); reject(new Error('Google authorization transport failed')); };
    const timer = setTimeout(fail, timeoutMs);
    session.on('error', fail); request.on('error', fail);
    request.on('response', headers => { status = Number(headers[':status']); });
    request.on('data', chunk => { size += chunk.length; if (size > 128 * 1024) return fail(); chunks.push(chunk); });
    request.on('end', () => {
      if (settled) return; settled = true; cleanup();
      let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reject(new Error('Google authorization returned an invalid JSON response')); return; }
      resolve({ status, data });
    });
    request.end(payload || undefined);
  });
}
