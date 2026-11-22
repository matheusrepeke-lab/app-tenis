// Teste de ponta a ponta no Chromium (Playwright).
// Uso: node test/e2e.cjs <video de entrada> <pasta de saída>
// Precisa do site servido em http://localhost:8766 (python3 -m http.server 8766).
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const [input, outDir] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:8766/');
  await page.setInputFiles('#file', input);
  const t0 = Date.now();
  await page.click('#go');
  let last = '';
  const timer = setInterval(async () => {
    try {
      const s = await page.evaluate(() => `${stage.textContent} ${barFill.style.width} ${eta.textContent}`);
      if (s !== last) { console.log(s); last = s; }
    } catch {}
  }, 2000);
  await page.waitForSelector('#done:not(.hidden), #err:not(.hidden)', { timeout: 15 * 60 * 1000 });
  clearInterval(timer);
  const err = await page.$eval('#err', (e) => (e.classList.contains('hidden') ? null : e.textContent));
  if (err) { console.log('ERRO:', err); process.exit(1); }
  console.log('Tempo total:', ((Date.now() - t0) / 1000).toFixed(1), 's');
  console.log(await page.$eval('#doneText', (e) => e.textContent));
  console.log(await page.$eval('#finalStats', (e) => e.innerText.replace(/\n/g, ' | ')));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const out = path.join(outDir, 'saida.mp4');
  await dl.saveAs(out);
  console.log('salvo em', out);
  await browser.close();
})();
