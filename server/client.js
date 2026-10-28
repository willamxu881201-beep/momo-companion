// One keep-alive HTTPS client for the model and speech APIs. From the server in
// Johor a new connection to Ark in Beijing costs about 1.7 s (TCP handshake plus
// TLS), so sockets stay open between turns, and warm() can open them while the
// child is still talking.

import https from 'node:https';

const agent = new https.Agent({ keepAlive: true, maxSockets: 8, scheduling: 'lifo', timeout: 55000 });

// Resolves with the response as soon as it starts, for reading as it arrives. The
// deadline covers the whole body: past it the response errors out. A request on a
// reused socket that the far end had already closed is retried once, as Node's
// documentation recommends, but only before any response has come back.
export function stream(url, { method = 'GET', headers = {}, body, timeoutMs = 25000 } = {}) {
  const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const attempt = (retry) =>
    new Promise((resolve, reject) => {
      let started = false;
      const req = https.request(url, {
        method,
        agent,
        headers: payload ? { ...headers, 'Content-Length': payload.length } : headers,
      });
      const timer = setTimeout(() => req.destroy(Object.assign(new Error(`timed out after ${timeoutMs} ms`), { name: 'TimeoutError' })), timeoutMs);
      req.on('response', (res) => {
        started = true;
        res.on('close', () => clearTimeout(timer));
        resolve(res);
      });
      req.on('error', (err) => {
        if (started) return; // the response reports it
        clearTimeout(timer);
        if (retry && req.reusedSocket && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) resolve(attempt(false));
        else reject(err);
      });
      req.end(payload || undefined);
    });
  return attempt(true);
}

// Resolves { status, headers, body: Buffer } once the whole response is in.
export async function request(url, options) {
  const res = await stream(url, options);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) };
}

// Open `count` connections to each origin ahead of time; failures do not matter.
export function warm(origins, count = 1) {
  for (const origin of origins) {
    for (let i = 0; i < count; i += 1) request(origin, { method: 'HEAD', timeoutMs: 10000 }).catch(() => {});
  }
}
