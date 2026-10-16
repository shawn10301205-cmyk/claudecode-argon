import './portable-config.mjs';
import net from 'node:net';

export async function tunnel(proxy, host) {
  if (!['robinfrontend-pa.googleapis.com', 'www.googleapis.com', 'oauth2.googleapis.com'].includes(host)) throw new Error('Unexpected upstream host');
  if (proxy === 'direct') return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: 443 });
    const fail = () => { socket.destroy(); reject(new Error('Direct upstream connection failed')); };
    socket.setTimeout(15000, fail); socket.once('error', fail);
    socket.once('connect', () => { socket.setTimeout(0); socket.off('error', fail); resolve(socket); });
  });
  const url = new URL(proxy);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Only a local HTTP proxy is supported');
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port || 80) });
    socket.setTimeout(15_000, () => socket.destroy(new Error('Proxy connect timed out')));
    const fail = error => { socket.destroy(); reject(error); };
    socket.once('error', fail);
    socket.once('connect', () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    let buffer = Buffer.alloc(0);
    const data = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) { if (buffer.length > 8192) fail(new Error('Oversized proxy response')); return; }
      socket.off('data', data); socket.off('error', fail); socket.setTimeout(0);
      if (!/^HTTP\/1\.[01] 200(?:\s|$)/.test(buffer.subarray(0, end).toString('ascii'))) return fail(new Error('Proxy rejected the upstream connection'));
      const tail = buffer.subarray(end + 4); if (tail.length) socket.unshift(tail);
      resolve(socket);
    };
    socket.on('data', data);
  });
}
