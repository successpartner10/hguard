'use strict';
// Simulates the GitHub Pages deployment:
//   app  = http://localhost:8080/hguard/   (static, no backend — like github.io)
//   api  = http://localhost:3000                  (the Node signaling server — like your tunnel/host)
// Camera and Monitor run from the "Pages" origin; every API call, upload, QR image,
// thumbnail, clip and WebSocket goes cross-origin to the backend via Server URL.
// Also checks the "no backend" banner behavior on the static origin.
const { chromium } = require('playwright');

const STATIC = 'http://localhost:8080/hguard/';
const API = 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ FAIL: ' + label); } };

(async () => {
  const t0 = Date.now();
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];

  const serverUrlScript = (url) => `localStorage.setItem('ahg.settings', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('ahg.settings') || '{}'), { serverUrl: '${url}' })));`;

  // ---------------- camera (Pages origin, Server URL = backend) ----------------
  console.log('== Camera on Pages origin, backend on :3000 ==');
  const camCtx = await browser.newContext();
  await camCtx.addInitScript(serverUrlScript(API));
  const cam = await camCtx.newPage();
  cam.on('pageerror', e => errors.push('CAM: ' + e.message));
  await cam.goto(STATIC, { waitUntil: 'domcontentloaded' });
  await cam.waitForFunction(() => !document.querySelector('#view-onboarding').classList.contains('hidden'), null, { timeout: 15000 });
  const connOn = await cam.evaluate(() => document.querySelector('#conn-dot').className === 'conn-dot on');
  ok(connOn, 'camera connects over cross-origin WebSocket (Server URL)');
  const bannerHidden = await cam.evaluate(() => document.querySelector('#server-hint').classList.contains('hidden'));
  ok(bannerHidden, 'no backend banner when Server URL is set');
  await cam.click('#btn-start-camera');
  await cam.fill('#camera-name-input', 'Pages Cam');
  await cam.click('#btn-camera-go');
  await cam.waitForSelector('#camera-dash:not(.hidden)', { timeout: 20000 });
  ok(true, 'camera dashboard up (demo mode)');
  const identity = await cam.evaluate(() => JSON.parse(localStorage.getItem('ahg.camera')));
  ok(identity && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(identity.code), 'camera registered via remote backend, code: ' + identity.code);

  // QR image loads cross-origin from the backend
  await cam.click('#btn-pair-monitor');
  await cam.waitForSelector('.pair-qr img', { timeout: 5000 });
  const qrOk = await cam.waitForFunction(() => { const i = document.querySelector('.pair-qr img'); return i && i.naturalWidth > 0; }, null, { timeout: 8000 }).then(() => true).catch(() => false);
  ok(qrOk, 'pairing QR loads cross-origin from backend');
  await cam.click('.modal-close');
  await cam.evaluate(() => { const s = document.querySelector('#sens-slider'); s.value = 100; s.dispatchEvent(new Event('input')); });

  // ---------------- monitor (Pages origin) ----------------
  console.log('== Monitor on Pages origin ==');
  const monCtx = await browser.newContext();
  await monCtx.addInitScript(serverUrlScript(API));
  const mon = await monCtx.newPage();
  mon.on('pageerror', e => errors.push('MON: ' + e.message));
  await mon.goto(STATIC, { waitUntil: 'domcontentloaded' });
  await mon.waitForFunction(() => !document.querySelector('#view-onboarding').classList.contains('hidden'), null, { timeout: 15000 });
  await mon.click('#btn-start-monitor');
  await mon.click('#btn-add-camera');
  await mon.fill('.pair-code-input', identity.code);
  await mon.click('#modal-root .modal-foot button:has-text("Pair")');
  await mon.waitForSelector('.cam-card', { timeout: 10000 });
  ok(true, 'paired across origins');

  // live WebRTC view (media device-to-device; signaling via remote backend)
  await mon.click('.cam-card');
  await mon.waitForSelector('.live-modal', { timeout: 5000 });
  const liveOk = await mon.waitForFunction(() => {
    const v = document.querySelector('.live-video-wrap video');
    return v && v.videoWidth > 0 && v.currentTime > 0;
  }, null, { timeout: 25000 }).then(() => true).catch(() => false);
  ok(liveOk, 'live WebRTC view works across origins');
  await mon.click('.modal-close');
  await mon.waitForTimeout(400);

  // ---------------- events + clips cross-origin ----------------
  console.log('== Events + clips via remote backend ==');
  await mon.click('.sub-tab[data-tab="timeline"]');
  try {
    await mon.waitForFunction(() => document.querySelectorAll('#timeline-list .tl-row').length > 0, null, { timeout: 60000 });
  } catch { /* noop */ }
  const rows = await mon.locator('#timeline-list .tl-row').count();
  ok(rows >= 1, `timeline shows ${rows} event(s)`);

  let ev = null;
  for (let i = 0; i < 25 && !ev; i++) {
    const state = await fetch(`${API}/api/events?limit=50&since=${t0}`).then(r => r.json());
    ev = state.events.find(e => e.clip && e.thumb);
    if (!ev) await new Promise(r => setTimeout(r, 1500));
  }
  ok(!!ev, 'clip + thumb stored on remote backend');
  if (ev) {
    const buf = await fetch(API + ev.clip).then(r => r.arrayBuffer());
    ok(buf.byteLength > 4000, `clip downloadable cross-origin (${(buf.byteLength / 1024).toFixed(0)} KB)`);
  }

  // ---------------- banner behavior on static origin ----------------
  console.log('== Banner (no Server URL) ==');
  const bare = await browser.newPage();
  bare.on('pageerror', e => errors.push('BARE: ' + e.message));
  await bare.goto(STATIC, { waitUntil: 'domcontentloaded' });
  const bareBanner = await bare.waitForFunction(() => !document.querySelector('#server-hint').classList.contains('hidden'), null, { timeout: 15000 }).then(() => true).catch(() => false);
  ok(bareBanner, 'banner shown on static origin when no Server URL configured');

  console.log('== Misc ==');
  const realErrors = errors.filter(e => !e.includes('favicon'));
  ok(realErrors.length === 0, 'no page errors' + (realErrors.length ? ' — ' + realErrors.slice(0, 3).join(' | ') : ''));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E ERROR:', e); process.exit(1); });
