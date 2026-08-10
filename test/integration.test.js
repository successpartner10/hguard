'use strict';
// Integration test: simulates a camera device + a monitor device against
// the signaling server, exercising the whole protocol end to end.
const WebSocket = require('ws');
const http = require('http');

const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000/ws';
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ FAIL: ' + label); } };

function api(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + path, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function wsClient() {
  const ws = new WebSocket(WS);
  const inbox = [];
  const waiters = [];
  const opened = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const wi = waiters.findIndex(w => w.type === msg.type);
    if (wi >= 0) { const [w] = waiters.splice(wi, 1); w.resolve(msg); }
    else inbox.push(msg);
  });
  const client = {
    ws,
    ready: opened,
    send: (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    next: (type, timeout = 4000) => new Promise((resolve, reject) => {
      const i = inbox.findIndex(m => m.type === type);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      const t = setTimeout(() => { const j = waiters.findIndex(w => w.type === type); if (j >= 0) { waiters.splice(j, 1); reject(new Error('timeout waiting for ' + type)); } }, timeout);
      waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m); } });
    }),
    call: (type, payload, timeout) => new Promise((resolve, reject) => {
      const reqId = 'r' + Math.random().toString(36).slice(2);
      const t = setTimeout(() => reject(new Error('timeout ' + type)), timeout || 4000);
      client.next('resp', timeout || 4000).then(m => { clearTimeout(t); m.reqId === reqId ? (m.ok ? resolve(m) : reject(new Error(m.message))) : reject(new Error('reqId mismatch')); }).catch(reject);
      // manual: listen for resp with reqId — simpler: hook next('resp') once
      client.send({ type, reqId, ...payload });
    }),
  };
  return client;
}

async function waitAll(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('== HTTP checks ==');
  let r = await api('/api/health');
  ok(r.status === 200 && JSON.parse(r.body).ok, 'GET /api/health');

  r = await api('/');
  ok(r.status === 200 && r.body.includes('AI Home Guard'), 'GET / serves the app');

  r = await api('/js/app.js');
  ok(r.status === 200 && r.body.includes('boot'), 'GET /js/app.js served');

  r = await api('/vendor/jsqr.js');
  ok(r.status === 200 && r.body.length > 100000, 'jsQR vendored & served');

  r = await api('/api/qr?code=AB12-CD34');
  ok(r.status === 200 && r.headers['content-type'] === 'image/png' && r.body[0] === 0x89, 'QR endpoint returns PNG');

  r = await api('/api/qr?code=nope');
  ok(r.status === 400, 'QR endpoint rejects bad codes');

  console.log('== Camera registration ==');
  const cam = wsClient();
  await cam.ready;
  const camReg = await cam.call('camera.register', { name: 'Front Door' });
  ok(camReg.camera && camReg.camera.id && camReg.camera.code && camReg.camera.token, 'camera.register returns id/code/token');
  const CAM = camReg.camera;

  r = await api('/api/state');
  let state = JSON.parse(r.body);
  ok(state.cameras.some(c => c.id === CAM.id && c.online), 'camera visible + online in /api/state');

  console.log('== Monitor pairing ==');
  const mon = wsClient();
  await mon.ready;
  await mon.call('monitor.hello');
  const pair = await mon.call('monitor.pair', { code: CAM.code });
  ok(pair.camera && pair.camera.id === CAM.id, 'monitor.pair works with code');

  const badPair = await mon.call('monitor.pair', { code: 'ZZZZ-ZZZZ' }).then(() => null, e => e);
  ok(badPair instanceof Error, 'bad pairing code rejected');

  // monitor gets status broadcasts
  cam.send({ type: 'camera.hello', id: CAM.id, token: CAM.token, armed: true });
  const stMsg = await mon.next('camera.status');
  ok(stMsg.camera && stMsg.camera.id === CAM.id && stMsg.camera.online === true, 'camera.hello → status broadcast to monitor');

  console.log('== WebRTC signaling relay ==');
  const watch = await mon.call('monitor.watch', { cameraId: CAM.id, sessId: 'sess-test-1' });
  ok(watch.sessId === 'sess-test-1', 'monitor.watch returns sessId');
  const watchMsg = await cam.next('monitor.watch');
  ok(watchMsg.sessId === 'sess-test-1', 'camera receives monitor.watch');

  // camera sends offer
  cam.send({ type: 'camera.signal', id: CAM.id, token: CAM.token, sessId: 'sess-test-1', data: { offer: { type: 'offer', sdp: 'v=0 fake' } } });
  const offerMsg = await mon.next('signal');
  ok(offerMsg.sessId === 'sess-test-1' && offerMsg.data.offer, 'offer relayed camera → monitor');

  // monitor answers
  mon.send({ type: 'monitor.signal', cameraId: CAM.id, sessId: 'sess-test-1', data: { answer: { type: 'answer', sdp: 'v=0 fake' } } });
  const answerMsg = await cam.next('signal');
  ok(answerMsg.sessId === 'sess-test-1' && answerMsg.data.answer, 'answer relayed monitor → camera');

  // ICE both ways
  cam.send({ type: 'camera.signal', id: CAM.id, token: CAM.token, sessId: 'sess-test-1', data: { ice: { candidate: 'cand-1' } } });
  const ice1 = await mon.next('signal');
  ok(ice1.data.ice && ice1.data.ice.candidate === 'cand-1', 'ICE relayed camera → monitor');

  mon.send({ type: 'monitor.signal', cameraId: CAM.id, sessId: 'sess-test-1', data: { ice: { candidate: 'cand-2' } } });
  const ice2 = await cam.next('signal');
  ok(ice2.data.ice && ice2.data.ice.candidate === 'cand-2', 'ICE relayed monitor → camera');

  console.log('== Events ==');
  cam.send({ type: 'camera.event', id: CAM.id, token: CAM.token, event: { id: 'ev-1', tag: 'person', at: Date.now(), dur: 6.4, conf: 0.91, zone: 'front door', energy: 55 } });
  const evNew = await mon.next('event.new');
  ok(evNew.event && evNew.event.id === 'ev-1' && evNew.event.tag === 'person' && evNew.event.cameraName === 'Front Door', 'camera.event → event.new to monitor with metadata');

  r = await api('/api/events');
  const evs = JSON.parse(r.body).events;
  ok(evs.some(e => e.id === 'ev-1'), 'event persisted → GET /api/events');

  console.log('== Clip + thumb upload ==');
  const clipBody = Buffer.alloc(2048, 7);
  r = await api('/api/clips?camera=' + CAM.id + '&event=ev-1&name=10-42-03_person.webm&tag=person&conf=0.91&zone=front&dur=6.4&at=' + Date.now(), { method: 'POST', body: clipBody, headers: { 'Content-Type': 'video/webm' } });
  ok(r.status === 200 && JSON.parse(r.body).url.startsWith('/clips/'), 'clip upload accepted');
  const clipUrl = JSON.parse(r.body).url;
  r = await api(clipUrl);
  ok(r.status === 200 && r.body.length === 2048 && r.headers['content-type'] === 'video/webm', 'clip downloadable');

  const jpeg = Buffer.from('ffd8ffe00010', 'hex');
  r = await api('/api/thumbs?camera=' + CAM.id + '&event=ev-1', { method: 'POST', body: jpeg, headers: { 'Content-Type': 'image/jpeg' } });
  ok(r.status === 200 && JSON.parse(r.body).url.startsWith('/thumbs/'), 'thumb upload accepted');

  r = await api('/api/state?events=10');
  const evAfter = JSON.parse(r.body).events.find(e => e.id === 'ev-1');
  ok(evAfter.clip && evAfter.thumb, 'clip+thumb attached to event');

  console.log('== Feedback / false-alarm learning relay ==');
  mon.send({ type: 'feedback', eventId: 'ev-1', value: false });
  const fbMsg = await cam.next('feedback');
  ok(fbMsg.eventId === 'ev-1' && fbMsg.value === 'down' && fbMsg.tag === 'person' && fbMsg.zone === 'front door', 'feedback relayed to camera with event details');

  // camera reconnect → feedback.sync
  const cam2 = wsClient();
  await cam2.ready;
  await cam2.call('camera.hello', { id: CAM.id, token: CAM.token, armed: true });
  const sync = await cam2.next('feedback.sync');
  ok(sync.items && sync.items.some(i => i.eventId === 'ev-1' && i.value === 'down'), 'feedback.sync on reconnect');

  console.log('== Presence ==');
  const stMsg2 = await mon.next('camera.status');
  ok(stMsg2.camera.viewers >= 1, 'viewer count reported to camera status');

  cam2.send({ type: 'camera.bye', id: CAM.id, token: CAM.token });
  let bye = null;
  for (let i = 0; i < 5; i++) { bye = await mon.next('camera.status'); if (bye.camera.online === false) break; }
  ok(bye.camera.online === false, 'camera.bye → offline broadcast');

  console.log('== Bandwidth probe ==');
  r = await api('/api/probe?kb=512');
  ok(r.status === 200 && r.body.length === 512 * 1024, 'probe returns requested bytes');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
