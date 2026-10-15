// Small helpers shared by the HTTP routes.

// Real client IP. The service is only reachable from the web container's nginx,
// which overwrites X-Client-IP (CF-Connecting-IP when present, else its peer) and
// blanks X-Forwarded-For / CF-Connecting-IP, so a client cannot pick its own IP.
export function ipFromHeaders(h) {
  const ip = h?.['x-client-ip'];
  return typeof ip === 'string' && ip.trim() ? ip.trim() : null;
}
export function clientIp(req) {
  return ipFromHeaders(req.headers) || req.socket.remoteAddress || 'unknown';
}

export class BodyTooLarge extends Error {}

// Reads the request body up to `max` bytes; rejects with BodyTooLarge beyond that.
export function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      return reject(new BodyTooLarge());
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        req.resume();
        return reject(new BodyTooLarge());
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export function sendStatus(res, status, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end();
}

// Token bucket keyed by an arbitrary string. `capacity` tokens, refilled at
// `perMs` tokens per millisecond. Idle buckets are dropped by sweep().
export class RateLimiter {
  constructor(capacity, windowMs) {
    this.capacity = capacity;
    this.rate = capacity / windowMs;
    this.buckets = new Map();
  }
  take(key, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, at: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * this.rate);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  sweep(now = Date.now()) {
    for (const [k, b] of this.buckets) {
      if (b.tokens + (now - b.at) * this.rate >= this.capacity) this.buckets.delete(k);
    }
  }
}
