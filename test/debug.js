const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('https://successpartner10.github.io/hguard/', { waitUntil: 'domcontentloaded' });
  const out = await page.evaluate(async () => {
    const t0 = Date.now() - 600000; // events from the last 10 min
    try {
      const r = await fetch('https://4c0809027dd4a6.lhr.life/api/events?limit=50&since=' + t0);
      const j = await r.json();
      const hits = j.events.filter(e => e.clip && e.thumb);
      return { status: r.status, total: j.events.length, withClipThumb: hits.length };
    } catch (e) { return 'FAIL: ' + e.message; }
  });
  console.log('POLL:', JSON.stringify(out));
  await browser.close();
})();
