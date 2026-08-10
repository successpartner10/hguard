// WebSocket client with auto-reconnect, request/response, and pub/sub.
// Talks to the local signaling server (later: Cloudflare Workers + Durable Objects
// implementing the same protocol).
import { store } from './utils.js';

// Resolve a server path to a full URL.
// - No Server URL configured (same-origin deployment): path is used as-is.
// - Server URL configured (e.g. app on GitHub Pages + backend elsewhere):
//   path is prefixed with it. Absolute URLs pass through untouched.
export function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  const base = (store.get('ahg.settings', {}).serverUrl || '').trim().replace(/\/+$/, '');
  return base ? base + path : path;
}

const listeners = new Map();   // type -> [fn]
const pending = new Map();     // reqId -> {resolve, reject, timer}

export const net = {
  ws: null,
  connected: false,
  _url: null,
  _reconnectTimer: null,
  _closedByUser: false,

  get serverUrl() {
    const s = store.get('ahg.settings', {});
    return (s.serverUrl || '').trim();
  },

  connect(onStatus) {
    if (onStatus) this.onStatus = onStatus;
    this._closedByUser = false;
    const base = (this.serverUrl || location.origin).trim();
    // The WebSocket scheme follows the SERVER, not the page: an https app
    // (e.g. GitHub Pages) may point at an http LAN server or an https tunnel.
    let wsProto;
    if (this.serverUrl) wsProto = base.startsWith('https') ? 'wss' : 'ws';
    else wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = wsProto + '://' + base.replace(/^https?:\/\//, '') + '/ws';
    this._url = url;
    this._open();
  },

  _open() {
    try { this.ws = new WebSocket(this._url); } catch (e) { this._retry(); return; }
    this.ws.onopen = () => {
      this.connected = true;
      this.onStatus && this.onStatus('on');
      this.emit('open');
      // flush queued outgoing messages
      while (this._queue.length) this.ws.send(this._queue.shift());
    };
    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'resp') {
        const p = pending.get(msg.reqId);
        if (p) { clearTimeout(p.timer); pending.delete(msg.reqId); msg.ok ? p.resolve(msg) : p.reject(new Error(msg.message || 'request failed')); }
        return;
      }
      if (msg.type === 'error') {
        const p = pending.get(msg.reqId);
        if (p) { clearTimeout(p.timer); pending.delete(msg.reqId); p.reject(new Error(msg.message || 'server error')); }
        else this.emit('server-error', msg);
        return;
      }
      this.emit(msg.type, msg);
    };
    this.ws.onclose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) this.onStatus && this.onStatus('err');
      this.emit('close');
      if (!this._closedByUser) this._retry();
    };
    this.ws.onerror = () => { try { this.ws.close(); } catch { /* noop */ } };
  },

  _retry() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.onStatus && this.onStatus('off');
      this._open();
    }, 2500);
  },

  _queue: [],

  send(msg) {
    if (this.connected && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    else this._queue.push(JSON.stringify(msg));
  },

  // fire-and-forget with optional payload
  emit(type, data) { (listeners.get(type) || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); },
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
    return () => { const a = listeners.get(type); if (a) a.splice(a.indexOf(fn), 1); };
  },

  // request/response with timeout (server replies {type:'resp', reqId, ok, ...})
  call(type, payload = {}, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const reqId = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { pending.delete(reqId); reject(new Error('No reply from server (timeout)')); }, timeout);
      pending.set(reqId, { resolve, reject, timer });
      this.send({ type, reqId, ...payload });
    });
  },

  // latency ping (ms)
  async ping() {
    const t0 = performance.now();
    await this.call('ping', {}, 5000);
    return Math.round(performance.now() - t0);
  },

  disconnect() {
    this._closedByUser = true;
    try { this.ws && this.ws.close(); } catch { /* noop */ }
  },
};
