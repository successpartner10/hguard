const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext();
  await ctx.setExtraHTTPHeaders({ 'bypass-tunnel-reminder': 'true' });
  await ctx.addInitScript(`localStorage.setItem('ahg.settings', JSON.stringify({ serverUrl: 'https://aihguard-test.loca.lt' }));`);
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (t.includes('upload failed') || t.includes('queue') || t.includes('upload') || m.type() === 'error') console.log('[cam:' + m.type() + ']', t.slice(0, 250)); });
  page.on('pageerror', e => console.log('[cam pageerror]', e.message.slice(0, 250)));
  await page.goto('https://successpartner10.github.io/hguard/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#conn-dot').classList.contains('on'), null, { timeout: 60000 }).catch(() => console.log('no WS'));
  await page.click('#btn-start-camera');
  await page.fill('#camera-name-input', 'Live Dbg');
  await page.click('#btn-camera-go');
  await page.waitForSelector('#camera-dash:not(.hidden)', { timeout: 30000 });
  await page.evaluate(() => { const s = document.querySelector('#sens-slider'); s.value = 100; s.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(90000);
  const st = await page.evaluate(() => {
    const c = window.__app.camera;
    return { localEvents: c.localEvents.length, last: c.localEvents[0] ? { dur: Math.round(c.localEvents[0].dur) } : null };
  });
  console.log('STATE:', JSON.stringify(st));
  await browser.close();
})();
