'use strict';
/**
 * AI Home Guard — local signaling server (Phase 1-5 dev backend).
 *
 * This is the temporary stand-in for Cloudflare Workers + Durable Objects:
 * it serves the web app, handles QR pairing codes, relays WebRTC signaling,
 * tracks camera presence, stores event metadata + clips, and relays
 * user feedback for false-alarm learning.
 *
 * It NEVER stores or proxies live video — media goes device-to-device
 * via WebRTC, exactly like the target Cloudflare architecture.
 *
 * Swap-in path (Phase 6, deferred): worker/ + durable-objects/ implement the
 * same message protocol below; clients talk to it via a configurable
 * SERVER_URL. Nothing about the client needs to change.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const db = require('./db');

const PORT = Number(process.env.PORT || 3000);
const WEB_ROOT = path.join(__dirname, '..', 'web');
const MAX_UPLOAD = 150 * 1024 * 1024; // 150 MB clip cap

// ---------------------------------------------------------------- mime
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- state
const cameras = new Map();   // id -> runtime info {id,name,code,token,online,lastSeen,armed,battery,signal,device,viewers:Set<ws>,sock}
const sessions = new Map();  // sessId -> { ws, cameraId }  (one per live view)
const monitorSocks = new Set();
// clips/thumbs can arrive before the event record (camera uploads clip first);
// remember them and attach when the event lands.
const pendingAttach = new Map(); // eventId -> { clip?, thumb? }

const isAliveTimeout = 15000;

function publicCamera(c) {
  const rt = cameras.get(c.id) || {};
  return {
    id: c.id, name: c.name, code: c.code, createdAt: c.createdAt,
    online: !!rt.online, armed: !!rt.armed, lastSeen: rt.lastSeen || null,
    battery: rt.battery, signal: rt.signal, device: rt.device,
    viewers: rt.viewers ? rt.viewers.size : 0,
  };
}

function broadcastToMonitors(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of monitorSocks) if (ws.readyState === 1) ws.send(raw);
}

function broadcastStatus(c) {
  broadcastToMonitors({ type: 'camera.status', camera: publicCamera(c) });
}

function pairCode() {
  const a = crypto.randomBytes(4).toString('hex').toUpperCase();
  const b = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${a.slice(0, 4)}-${b.slice(0, 4)}`;
}
function genId(prefix) { return prefix + '-' + crypto.randomBytes(6).toString('hex'); }

// heartbeat sweep — mark cameras offline after silence
setInterval(() => {
  const nowT = Date.now();
  for (const c of cameras.values()) {
    if (c.online && nowT - c.lastSeen > isAliveTimeout) {
      c.online = false;
      console.log(`[server] camera offline: ${c.name} (${c.id})`);
      broadcastStatus(c);
    }
  }
}, 5000).unref();

// ---------------------------------------------------------------- http
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(WEB_ROOT, p));
  if (!file.startsWith(WEB_ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function readBody(req, cb) {
  let size = 0; const chunks = [];
  req.on('data', (ch) => {
    size += ch.length;
    if (size > MAX_UPLOAD) { req.destroy(); cb(new Error('too large')); return; }
    chunks.push(ch);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', cb);
}

const server = http.createServer((req, res) => {
  // CORS: the app may be served from a different origin than the API server
  // (e.g. GitHub Pages app + this server as the backend). WebSockets don't
  // need CORS, but the REST calls do.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // 'bypass-tunnel-reminder' is sent by automation/testing tools to skip
  // localtunnel's interstitial; allow it so preflights from the app pass.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, bypass-tunnel-reminder');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/health') {
    return sendJson(res, 200, { ok: true, time: Date.now(), version: 'local-dev-0.1' });
  }

  // QR code image for pairing: /api/qr?code=XXXX-XXXX
  if (req.method === 'GET' && p === '/api/qr') {
    const code = String(url.searchParams.get('code') || '').toUpperCase();
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return sendJson(res, 400, { error: 'bad code' });
    QRCode.toBuffer(`aihguard://pair/${code}`, { width: 480, margin: 2, errorCorrectionLevel: 'M' })
      .then(buf => {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(buf);
      })
      .catch(e => sendJson(res, 500, { error: e.message }));
    return;
  }

  // recover a camera's pairing code (authenticated by token)
  if (req.method === 'GET' && p === '/api/code') {
    const cam = db.getCamera(url.searchParams.get('id'));
    if (!cam || cam.token !== url.searchParams.get('token')) return sendJson(res, 403, { error: 'bad credentials' });
    return sendJson(res, 200, { code: cam.code });
  }

  // live camera/event state (for fresh monitor loads)
  if (req.method === 'GET' && p === '/api/state') {
    const cams = db.listCameras().map(publicCamera);
    const events = db.getEvents({ limit: Number(url.searchParams.get('events') || 100) });
    return sendJson(res, 200, { cameras: cams, events });
  }

  if (req.method === 'GET' && p === '/api/events') {
    const q = url.searchParams;
    return sendJson(res, 200, {
      events: db.getEvents({
        cameraId: q.get('camera') || undefined,
        since: q.get('since') ? Number(q.get('since')) : undefined,
        tag: q.get('tag') || undefined,
        limit: q.get('limit') ? Number(q.get('limit')) : undefined,
      }),
    });
  }

  // clip upload: POST /api/clips?camera=ID&event=EID&name=FILE&tag=&conf=&zone=&dur=&at=
  if (req.method === 'POST' && p === '/api/clips') {
    const q = url.searchParams;
    const cameraId = q.get('camera');
    const cam = db.getCamera(cameraId);
    if (!cam) return sendJson(res, 404, { error: 'unknown camera' });
    const name = String(q.get('name') || '').replace(/[^\w.\-]/g, '_');
    if (!name) return sendJson(res, 400, { error: 'name required' });
    readBody(req, (err, buf) => {
      if (err) return sendJson(res, 413, { error: err.message });
      const file = db.clipPath(cameraId, name);
      fs.writeFile(file, buf, (werr) => {
        if (werr) return sendJson(res, 500, { error: werr.message });
        const urlPath = `/clips/${cameraId}/${new Date().toISOString().slice(0, 10)}/${name}`;
        console.log(`[server] clip stored ${buf.length} bytes: ${urlPath}`);
        // attach clip to its event so the timeline can play it
        const evId = q.get('event');
        const ev = db.getEvents({ limit: 5000 }).find(e => e.id === evId);
        if (ev) { ev.clip = urlPath; ev.clipSize = buf.length; }
        else {
          const p = pendingAttach.get(evId) || {};
          p.clip = urlPath; p.clipSize = buf.length;
          pendingAttach.set(evId, p);
        }
        sendJson(res, 200, { ok: true, url: urlPath });
      });
    });
    return;
  }

  // thumbnail upload: POST /api/thumbs?camera=ID&event=EID
  if (req.method === 'POST' && p === '/api/thumbs') {
    const q = url.searchParams;
    const cameraId = q.get('camera');
    const cam = db.getCamera(cameraId);
    if (!cam) return sendJson(res, 404, { error: 'unknown camera' });
    readBody(req, (err, buf) => {
      if (err) return sendJson(res, 413, { error: err.message });
      const name = `${q.get('event') || genId('t')}.jpg`;
      const file = db.thumbPath(cameraId, name);
      fs.writeFile(file, buf, (werr) => {
        if (werr) return sendJson(res, 500, { error: werr.message });
        const urlPath = `/thumbs/${cameraId}/${name}`;
        const evId = q.get('event');
        const ev = db.getEvents({ limit: 5000 }).find(e => e.id === evId);
        if (ev) ev.thumb = urlPath;
        else {
          const p = pendingAttach.get(evId) || {};
          p.thumb = urlPath;
          pendingAttach.set(evId, p);
        }
        sendJson(res, 200, { ok: true, url: urlPath });
      });
    });
    return;
  }

  // bandwidth probe for the diagnostics screen
  if (req.method === 'GET' && p === '/api/probe') {
    const kb = Math.min(8192, Math.max(64, Number(url.searchParams.get('kb') || 512)));
    const buf = crypto.randomBytes(kb * 1024);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
    return;
  }

  // stored files
  if (p.startsWith('/clips/') || p.startsWith('/thumbs/')) {
    const dirs = db.publicDir();
    const root = p.startsWith('/clips/') ? dirs.clips : dirs.thumbs;
    const file = path.normalize(path.join(root, p.split('/').slice(2).join('/')));
    if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      });
      res.end(buf);
    });
    return;
  }

  // everything else: static web app (SPA — fall back to index.html)
  if (req.method === 'GET' && (p.startsWith('/js/') || p.startsWith('/css/') || p.startsWith('/vendor/') || p.startsWith('/assets/'))) {
    return serveStatic(req, res, p);
  }
  serveStatic(req, res, '/index.html');
});

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server, path: '/ws' });

function reply(ws, reqId, data) {
  ws.send(JSON.stringify({ type: 'resp', reqId, ok: true, ...data }));
}
function fail(ws, reqId, message) {
  ws.send(JSON.stringify({ type: 'error', reqId, message }));
}

function isMonitor(ws) { return monitorSocks.has(ws); }
function isCamera(ws) { return !!ws.cam; }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({
    type: 'hello',
    time: Date.now(),
    cameras: db.listCameras().map(publicCamera),
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const t = msg.type;
    const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

    // ---- generic ----
    if (t === 'ping') return reply(ws, msg.reqId, { pong: Date.now() });

    // ---- CAMERA side ----
    if (t === 'camera.register') {
      const name = String(msg.name || 'My Camera').trim().slice(0, 40) || 'My Camera';
      const cam = {
        id: genId('cam'), name, code: pairCode(), token: crypto.randomBytes(24).toString('hex'),
        createdAt: Date.now(),
      };
      db.upsertCamera(cam);
      cameras.set(cam.id, { ...cam, online: true, lastSeen: Date.now(), armed: true, viewers: new Set(), sock: ws });
      ws.cam = cam; ws.role = 'camera'; ws.monitors = new Set();
      console.log(`[server] camera registered: ${name} (${cam.id}) code=${cam.code}`);
      reply(ws, msg.reqId, { camera: cam });
      broadcastStatus(cam);
      return;
    }

    if (t === 'camera.hello') {
      const cam = db.getCamera(msg.id);
      if (!cam || cam.token !== msg.token) return fail(ws, msg.reqId, 'bad camera credentials');
      ws.cam = cam; ws.role = 'camera';
      const rt = cameras.get(cam.id) || { viewers: new Set() };
      rt.sock = ws; rt.online = true; rt.lastSeen = Date.now();
      if (msg.armed !== undefined) rt.armed = !!msg.armed;
      cameras.set(cam.id, rt);
      console.log(`[server] camera online: ${cam.name}`);
      reply(ws, msg.reqId, { ok: true });
      broadcastStatus(cam);
      // sync pending feedback for false-alarm learning (with event details)
      const fb = db.getFeedbackForCamera(cam.id);
      if (fb.length) {
        const items = fb.map(f => {
          const ev = db.getEvents({ limit: 5000 }).find(e => e.id === f.eventId) || {};
          return { eventId: f.eventId, value: f.value, at: ev.at || f.at, tag: ev.tag, zone: ev.zone, energy: ev.energy };
        });
        send({ type: 'feedback.sync', items });
      }
      return;
    }

    if (t === 'camera.heartbeat') {
      const cam = db.getCamera(msg.id);
      if (!cam || cam.token !== msg.token) return;
      const rt = cameras.get(cam.id);
      if (!rt) return;
      rt.online = true; rt.lastSeen = Date.now();
      if (msg.armed !== undefined) rt.armed = !!msg.armed;
      if (msg.battery !== undefined) rt.battery = msg.battery;
      if (msg.signal !== undefined) rt.signal = msg.signal;
      if (msg.device !== undefined) rt.device = msg.device;
      if (msg.armed !== undefined || msg.battery !== undefined || msg.signal !== undefined) {
        broadcastStatus(cam);
      }
      return;
    }

    if (t === 'camera.signal') {
      const cam = db.getCamera(msg.id);
      if (!cam || cam.token !== msg.token) return;
      const sess = sessions.get(msg.sessId);
      if (!sess || sess.cameraId !== cam.id) return fail(ws, msg.reqId, 'no such session');
      if (sess.ws.readyState === 1) {
        sess.ws.send(JSON.stringify({ type: 'signal', cameraId: cam.id, sessId: msg.sessId, data: msg.data }));
      }
      return;
    }

    if (t === 'camera.snapshot') {
      const cam = db.getCamera(msg.id);
      if (!cam || cam.token !== msg.token) return;
      const sess = sessions.get(msg.sessId);
      if (!sess || sess.cameraId !== cam.id) return;
      sess.ws.send(JSON.stringify({ type: 'snapshot', cameraId: cam.id, dataUrl: msg.dataUrl }));
      return;
    }

    if (t === 'camera.event') {
      const cam = db.getCamera(msg.id);
      if (!cam || cam.token !== msg.token) return;
      const ev = {
        id: msg.event.id, cameraId: cam.id, cameraName: cam.name,
        tag: msg.event.tag, at: msg.event.at, dur: msg.event.dur || 0,
        conf: msg.event.conf, zone: msg.event.zone, suppressed: !!msg.event.suppressed,
        energy: msg.event.energy, thumb: null, clip: null,
      };
      // attach clip/thumb if they arrived before the event record
      const pa = pendingAttach.get(ev.id);
      if (pa) {
        if (pa.clip) { ev.clip = pa.clip; ev.clipSize = pa.clipSize; }
        if (pa.thumb) ev.thumb = pa.thumb;
        pendingAttach.delete(ev.id);
      }
      db.addEvent(ev);
      broadcastToMonitors({ type: 'event.new', event: ev });
      return;
    }

    if (t === 'camera.bye') {
      const cam = db.getCamera(msg.id);
      if (!cam || cam.token !== msg.token) return;
      const rt = cameras.get(cam.id);
      if (rt) { rt.online = false; rt.sock = null; }
      console.log(`[server] camera offline (bye): ${cam.name}`);
      broadcastStatus(cam);
      return;
    }

    // ---- MONITOR side ----
    if (t === 'monitor.hello') {
      ws.role = 'monitor';
      monitorSocks.add(ws);
      reply(ws, msg.reqId, { ok: true });
      return;
    }

    if (t === 'monitor.pair') {
      const code = String(msg.code || '').replace(/\s/g, '').toUpperCase();
      const cam = db.getCameraByCode(code);
      if (!cam) return fail(ws, msg.reqId, 'That code does not match any camera. Check the code on the camera device and try again.');
      if (ws.role !== 'monitor') { ws.role = 'monitor'; monitorSocks.add(ws); }
      reply(ws, msg.reqId, { camera: publicCamera(cam) });
      return;
    }

    if (t === 'monitor.watch') {
      const cam = db.getCamera(msg.cameraId);
      if (!cam) return fail(ws, msg.reqId, 'unknown camera');
      if (ws.role !== 'monitor') { ws.role = 'monitor'; monitorSocks.add(ws); }
      const sessId = msg.sessId || genId('sess');
      sessions.set(sessId, { ws, cameraId: cam.id });
      const rt = cameras.get(cam.id);
      if (rt) { rt.viewers.add(ws); broadcastStatus(cam); }
      const sock = rt && rt.sock;
      if (sock && sock.readyState === 1) {
        sock.send(JSON.stringify({ type: 'monitor.watch', sessId }));
      } else {
        fail(ws, msg.reqId, 'Camera is offline right now. It will reconnect automatically when it comes back.');
      }
      reply(ws, msg.reqId, { sessId });
      return;
    }

    if (t === 'monitor.unwatch') {
      const sess = sessions.get(msg.sessId);
      if (sess) {
        const rt = cameras.get(sess.cameraId);
        if (rt) { rt.viewers.delete(sess.ws); broadcastStatus(db.getCamera(sess.cameraId)); }
        const sock = rt && rt.sock;
        if (sock && sock.readyState === 1) {
          sock.send(JSON.stringify({ type: 'monitor.unwatch', sessId: msg.sessId }));
        }
        sessions.delete(msg.sessId);
      }
      return;
    }

    if (t === 'monitor.signal') {
      const cam = db.getCamera(msg.cameraId);
      if (!cam) return;
      const rt = cameras.get(cam.id);
      const sock = rt && rt.sock;
      if (sock && sock.readyState === 1) {
        sock.send(JSON.stringify({ type: 'signal', sessId: msg.sessId, data: msg.data }));
      }
      return;
    }

    if (t === 'monitor.snapshot') {
      const rt = cameras.get(msg.cameraId);
      const sock = rt && rt.sock;
      if (sock && sock.readyState === 1) {
        sock.send(JSON.stringify({ type: 'monitor.snapshot', sessId: msg.sessId }));
      }
      return;
    }

    if (t === 'feedback') {
      const ev = db.getEvents({ limit: 5000 }).find(e => e.id === msg.eventId);
      if (!ev) return;
      const value = msg.value === false ? 'down' : 'up';
      ev.feedback = value;
      db.addFeedback({ cameraId: ev.cameraId, eventId: ev.id, value, at: Date.now() });
      const rt = cameras.get(ev.cameraId);
      const sock = rt && rt.sock;
      if (sock && sock.readyState === 1) {
        sock.send(JSON.stringify({
          type: 'feedback', eventId: ev.id, value,
          tag: ev.tag, zone: ev.zone, at: ev.at, conf: ev.conf, dur: ev.dur,
        }));
      }
      return;
    }

    if (t === 'monitor.bye') {
      monitorSocks.delete(ws);
      for (const [sid, s] of sessions) if (s.ws === ws) {
        const rt = cameras.get(s.cameraId);
        if (rt) { rt.viewers.delete(ws); broadcastStatus(db.getCamera(s.cameraId)); }
        const sock = rt && rt.sock;
        if (sock && sock.readyState === 1) sock.send(JSON.stringify({ type: 'monitor.unwatch', sessId: sid }));
        sessions.delete(sid);
      }
      return;
    }
  });

  ws.on('close', () => {
    monitorSocks.delete(ws);
    if (ws.cam) {
      const rt = cameras.get(ws.cam.id);
      if (rt && rt.sock === ws) { rt.online = false; rt.sock = null; }
      broadcastStatus(ws.cam);
    }
    for (const [sid, s] of [...sessions]) {
      if (s.ws === ws) {
        const rt = cameras.get(s.cameraId);
        if (rt) { rt.viewers.delete(ws); broadcastStatus(db.getCamera(s.cameraId)); }
        const sock = rt && rt.sock;
        if (sock && sock.readyState === 1) sock.send(JSON.stringify({ type: 'monitor.unwatch', sessId: sid }));
        sessions.delete(sid);
      }
    }
  });
});

// connection keep-alive
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* noop */ }
  }
}, 20000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  AI Home Guard — local server`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Open http://localhost:${PORT} on any device on this network`);
  console.log(`  (phone, tablet, laptop — each device picks Camera or Monitor mode)\n`);
});
