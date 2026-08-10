const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) errs.push(m.text()); });
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  await page.click('#btn-start-camera');
  await page.fill('#camera-name-input', 'Extra');
  await page.click('#btn-camera-go');
  await page.waitForSelector('#camera-dash:not(.hidden)', { timeout: 15000 });

  // settings modal: open, check sections, save
  await page.click('#btn-cam-settings');
  await page.waitForSelector('.modal', { timeout: 5000 });
  const txt = await page.textContent('.modal');
  const ok1 = txt.includes('Server URL') && txt.includes('Retention') && txt.includes('Reset app data');
  console.log(ok1 ? '✓ settings modal shows all sections' : '✗ settings modal incomplete');
  await page.click('#modal-root .modal-foot .btn-primary');
  await page.waitForTimeout(300);

  // zones toggle
  await page.click('#btn-zones');
  const editing = await page.evaluate(() => document.querySelector('.preview-wrap').classList.contains('zone-editing'));
  console.log(editing ? '✓ zone editing mode engages' : '✗ zone editing not engaging');
  await page.click('#btn-exit-zones');
  const done = await page.evaluate(() => !document.querySelector('.preview-wrap').classList.contains('zone-editing'));
  console.log(done ? '✓ zone editing exits' : '✗ zone editing exit failed');

  // night toggle
  await page.click('#btn-night');
  const night = await page.evaluate(() => document.querySelector('#btn-night').classList.contains('active'));
  console.log(night ? '✓ night mode toggles' : '✗ night toggle failed');
  await page.click('#btn-night');

  // AI toggle
  await page.click('#btn-ai');
  const aiOff = await page.evaluate(() => !document.querySelector('#btn-ai').classList.contains('active'));
  console.log(aiOff ? '✓ AI toggle disables' : '✗ AI toggle failed');
  await page.click('#btn-ai');

  // armed toggle
  await page.click('.switch');
  await page.waitForTimeout(200);
  const label = await page.textContent('#armed-label');
  console.log(label === 'Disarmed' ? '✓ disarm works' : '✗ disarm failed: ' + label);
  await page.click('.switch');

  console.log(errs.length ? 'PAGE ERRORS: ' + JSON.stringify(errs.slice(0, 5)) : '✓ no page errors');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
