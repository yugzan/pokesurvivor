// Test helpers: a fake game page (protocol section 1) and an MCP agent client.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FakePage {
  constructor(base) {
    this.base = base;
    this.events = [];          // { event, data }
    this.pings = 0;
    this.listeners = new Set();
    this.onCmd = null;         // async (cmd) => result object, or undefined to stay silent
  }

  async createSession() {
    const r = await fetch(`${this.base}/agent/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (r.status !== 200) throw new Error(`session status ${r.status}`);
    Object.assign(this, await r.json());
    return this;
  }

  async connect() {
    this.ctrl = new AbortController();
    const mark = this.events.length;
    const r = await fetch(`${this.base}/agent/stream?sid=${this.sid}`, { signal: this.ctrl.signal });
    this.streamResponse = r;
    if (r.status !== 200) return r;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            this.handleBlock(block);
          }
        }
      } catch { /* aborted */ }
      this.closed = true;
    })();
    await this.waitEvent('hello', 3000, mark);
    return r;
  }

  handleBlock(block) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) { this.pings++; continue; }
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) return;
    const ev = { event, data: JSON.parse(data.join('\n')) };
    this.events.push(ev);
    for (const l of this.listeners) l(ev);
    if (event === 'cmd' && this.onCmd) {
      Promise.resolve(this.onCmd(ev.data)).then((res) => {
        if (res) return this.report({ results: [{ id: ev.data.id, ...res }] });
      }).catch(() => {});      // the test (and its server) may already be gone
    }
  }

  waitEvent(name, timeoutMs = 3000, from = 0) {
    const found = this.events.slice(from).find((e) => e.event === name);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.listeners.delete(l); reject(new Error(`timeout waiting for ${name}`)); }, timeoutMs);
      const l = (e) => { if (e.event === name) { clearTimeout(t); this.listeners.delete(l); resolve(e); } };
      this.listeners.add(l);
    });
  }

  async report(body) {
    const r = await fetch(`${this.base}/agent/report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid: this.sid, ...body }),
    });
    return r.status;
  }

  disconnect() { this.ctrl?.abort(); }
}

export async function newAgent(base, name = 'test-agent', headers) {
  const client = new Client({ name, version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), headers ? { requestInit: { headers } } : undefined);
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let value;
    try { value = JSON.parse(text); } catch { value = text; }
    return { isError: !!r.isError, text, value };
  };
  return { client, transport, call, close: async () => { try { await transport.terminateSession(); } catch {} await client.close(); } };
}
