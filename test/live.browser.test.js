'use strict';
// THE definitive live test: the real deployed GitHub Pages app
// (https://successpartner10.github.io/hguard/) talking to the real backend
// through a public https tunnel (https://aihguard-test.loca.lt).
// Camera + Monitor in two tabs: pair, live WebRTC, motion event, clip upload.
const { chromium } = require('playwright');

const LIVE = 'https://successpartner10.github.io/hguard/';
const TUNNEL = 'https://aihguard-test.loca.lt';
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ FAIL: ' + label); } };

(async () => {
  const t0 = Date.now();
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const setup = async () => {
    const ctx = await browser.newContext();
    // loca.lt interstitial bypass + point the app at the tunnel
    await ctx.setExtraHTTPHeaders({ 'bypass-tunnel-reminder': 'true' });
    await ctx.addInitScript(`localStorage.setItem('ahg.settings', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('ahg.settings') || '{}'), { serverUrl: '${TUNNEL}' })));`);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message.slice(0, 150)));
    return page;
  };

  console.log('== Live github.io · camera tab ==');
  const cam = await setup();
  await cam.goto(LIVE, { waitUntil: 'domcontentloaded' });
  await cam.waitForFunction(() => !document.querySelector('#view-onboarding').classList.contains('hidden'), null, { timeout: 30000 });
  let connected = false;
  for (let attempt = 1; attempt <= 3 && !connected; attempt++) {
    connected = await cam.waitForFunction(() => document.querySelector('#conn-dot').classList.contains('on'), null, { timeout: 45000 }).then(() => true).catch(() => false);
    if (!connected) {
      console.log(`    attempt ${attempt}: no WS yet — reloading`);
      await cam.reload({ waitUntil: 'domcontentloaded' });
      await cam.waitForTimeout(3000);
    }
  }
  ok(connected, 'camera connects to backend through the public tunnel (https→wss)');
  await cam.click('#btn-start-camera');
  await cam.fill('#camera-name-input', 'Live Cam');
  await cam.click('#btn-camera-go');
  await cam.waitForSelector('#camera-dash:not(.hidden)', { timeout: 30000 });
  ok(true, 'camera dashboard up on github.io');
  const identity = await cam.evaluate(() => JSON.parse(localStorage.getItem('ahg.camera')));
  ok(identity && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(identity.code), 'camera registered via tunnel, code ' + identity.code);
  await cam.evaluate(() => { const s = document.querySelector('#sens-slider'); s.value = 100; s.dispatchEvent(new Event('input')); });

  console.log('== Live github.io · monitor tab ==');
  const mon = await setup();
  await mon.goto(LIVE, { waitUntil: 'domcontentloaded' });
  await mon.waitForFunction(() => !document.querySelector('#view-onboarding').classList.contains('hidden'), null, { timeout: 30000 });
  await mon.click('#btn-start-monitor');

  // pairing over a public tunnel can be flaky — retry a few times
  let paired = false;
  for (let attempt = 1; attempt <= 4 && !paired; attempt++) {
    if (attempt > 1) await mon.waitForTimeout(2500);
    await mon.click('#btn-add-camera');
    await mon.fill('.pair-code-input', identity.code);
    await mon.click('#modal-root .modal-foot button:has-text("Pair")');
    try {
      await mon.waitForSelector('.cam-card', { timeout: 15000 });
      paired = true;
    } catch {
      const toastTxt = await mon.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')).catch(() => '');
      console.log(`    attempt ${attempt}: no card yet${toastTxt ? ' — ' + toastTxt : ''}`);
      await mon.keyboard.press('Escape').catch(() => {});
    }
  }
  ok(paired, 'paired camera on github.io monitor');
  await mon.click('.cam-card');
  await mon.waitForSelector('.live-modal', { timeout: 8000 });
  const liveOk = await mon.waitForFunction(() => {
    const v = document.querySelector('.live-video-wrap video');
    return v && v.videoWidth > 0 && v.currentTime > 0;
  }, null, { timeout: 30000 }).then(() => true).catch(() => false);
  ok(liveOk, 'live WebRTC view works on github.io (device→device via tunnel signaling)');
  await mon.click('.modal-close');

  console.log('== Live github.io · events ==');
  await mon.click('.sub-tab[data-tab="timeline"]');
  try {
    await mon.waitForFunction(() => document.querySelectorAll('#timeline-list .tl-row').length > 0, null, { timeout: 60000 });
  } catch { /* noop */ }
  const rows = await mon.locator('#timeline-list .tl-row').count();
  ok(rows >= 1, `timeline shows ${rows} event(s)`);

  // the clip + thumb upload through the tunnel can take a while — poll longer
  // (the app also retries queued uploads every 30s)
  let ev = null;
  for (let i = 0; i < 90 && !ev; i++) {
    try {
      const state = await mon.evaluate(async (u) => (await fetch(`${u}/api/events?limit=50&since=${t0}`)).json(), TUNNEL);
      ev = state.events.find(e => e.clip && e.thumb);
    } catch { /* tunnel hiccup — retry */ }
    if (!ev) await new Promise(r => setTimeout(r, 2000));
  }
  ok(!!ev, 'clip + thumb stored via tunnel backend');
  if (ev) {
    let size = 0;
    for (let i = 0; i < 5 && !size; i++) {
      try {
        size = await mon.evaluate(async (url) => {
          const r = await fetch(url);
          const buf = await r.arrayBuffer();
          return buf.byteLength;
        }, TUNNEL + ev.clip);
      } catch { await new Promise(r => setTimeout(r, 2000)); }
    }
    ok(size > 4000, `clip downloadable over public https (${(size / 1024).toFixed(0)} KB)`);
  }

  console.log('== Misc ==');
  const realErrors = errors.filter(e => !e.includes('favicon'));
  ok(realErrors.length === 0, 'no page errors on github.io' + (realErrors.length ? ' — ' + realErrors.slice(0, 3).join(' | ') : ''));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('LIVE TEST ERROR:', e); process.exit(1); });
