const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const fs = require('fs'); const path = require('path');
(async () => {
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('file://' + path.resolve(__dirname, '../dist/CNCStudio.html')); await page.waitForTimeout(200);
  await page.click('button[data-tool="rect"]');
  const box = await page.locator('#cv').boundingBox();
  // bed is centered; drag in lower-left region of the bed
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 60, cy + 300); await page.mouse.down(); await page.mouse.move(cx + 40, cy + 200, { steps: 5 }); await page.mouse.up();
  await page.click('button[data-tool="circle"]');
  await page.mouse.move(cx + 100, cy + 250); await page.mouse.down(); await page.mouse.move(cx + 130, cy + 250, { steps: 5 }); await page.mouse.up();
  await page.click('button[data-tool="poly"]');
  await page.mouse.click(cx - 60, cy + 100); await page.mouse.click(cx + 20, cy + 100); await page.mouse.click(cx + 20, cy + 40); await page.mouse.click(cx - 20, cy + 20); await page.mouse.dblclick(cx - 60, cy + 100 - 1);
  await page.check('#chkKerf');
  await page.mouse.move(cx, cy + 150);
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => window.CNC.job.shapes.map(s => `${s.kind} ${s.x.toFixed(2)},${s.y.toFixed(2)} ${s.w || s.r || s.pts?.length}`));
  console.log(info); console.log(await page.textContent('#jobStats'));
  await page.screenshot({ path: path.join(__dirname, 'shot_draw.png') });
  console.log('errors', errors); await browser.close();
})();
