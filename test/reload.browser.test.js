const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  await page.click('#btn-start-camera');
  await page.fill('#camera-name-input', 'Reload Test');
  await page.click('#btn-camera-go');
  await page.waitForSelector('#camera-dash:not(.hidden)', { timeout: 15000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const afterReload = await page.evaluate(() => ({
    dashVisible: !document.querySelector('#camera-dash').classList.contains('hidden'),
    title: document.querySelector('#cam-title')?.textContent,
    online: [...document.querySelectorAll('#cam-chips .chip')].map(c => c.innerText).join('|'),
  }));
  console.log(afterReload.dashVisible && afterReload.title === 'Reload Test' && afterReload.online.includes('Armed')
    ? '✓ camera identity + armed state survive reload'
    : '✗ reload restore failed: ' + JSON.stringify(afterReload));
  console.log(errs.length ? 'ERRORS: ' + errs.join('; ') : '✓ no page errors');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
