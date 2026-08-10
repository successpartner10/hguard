const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') console.log('[' + m.type() + ']', m.text().slice(0, 200)); });
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.click('#btn-start-camera');
  await page.fill('#camera-name-input', 'Dbg');
  await page.click('#btn-camera-go');
  await page.waitForSelector('#camera-dash:not(.hidden)', { timeout: 15000 });
  await page.evaluate(() => { const s = document.querySelector('#sens-slider'); s.value = 100; s.dispatchEvent(new Event('input')); });
  for (let i = 0; i < 26; i++) {
    await page.waitForTimeout(2000);
    const st = await page.evaluate(() => {
      const c = window.__app.camera;
      return {
        localEvents: c.localEvents.length,
        last: c.localEvents[0] ? { tag: c.localEvents[0].tag, dur: Math.round(c.localEvents[0].dur) } : null,
        eventAge: c.event ? Math.round((Date.now() - c.event.startedAt) / 1000) : 0,
        recState: c.recorder.recorder ? c.recorder.recorder.state : 'none',
        queue: -1,
      };
    });
    console.log('t+' + ((i + 1) * 2) + 's', JSON.stringify(st));
    if (st.localEvents > 0 && st.eventAge === 0) break;
  }
  await browser.close();
})();
