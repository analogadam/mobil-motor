// Panelin görsel/işlev testi: başsız Edge (pencere açmaz). Geliştirme makinesinde çalışır.
// Kullanım: node qa/arayuz.cjs <playwright-core yolu> <çıktı klasörü> [odaklanılacak seri]
const [, , pwPath, outDir, focusSerial] = process.argv;
const { chromium } = require(pwPath);
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const { token, port } = JSON.parse(fs.readFileSync(path.join(root, 'data', '.oturum'), 'utf8'));
  const adb = path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
  const b = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [];
  const out = {};
  const p = await b.newPage({ viewport: { width: 1600, height: 950 }, colorScheme: 'dark' });
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/giris?t=${token}`);
  await p.waitForTimeout(3000);
  if (focusSerial) {
    // Rafta ilgili cihaza tıkla → odak
    await p.locator('.dev', { has: p.locator(`[title="${focusSerial}"]`) }).click();
  }
  await p.waitForTimeout(6000);
  out.canvas = await p.evaluate(() => {
    const t = document.querySelector('.tile.focus canvas');
    if (!t || t.hidden || t.width <= 300) return { video: false };
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 80;
    const g = c.getContext('2d');
    g.drawImage(t, 0, 0, 40, 80);
    const d = g.getImageData(0, 0, 40, 80).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
    return { video: true, size: `${t.width}x${t.height}`, doluluk: Math.round((lit / 3200) * 100) + '%' };
  });
  out.odak = await p.evaluate(() => document.querySelector('.tile.focus .plate b')?.textContent);
  out.kutucuklar = await p.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => (t.querySelector('canvas:not([hidden])') ? 'video' : t.querySelector('img:not([hidden])') ? 'resim' : 'boş')));
  out.aktifAkis = execFileSync(adb, ['forward', '--list'], { encoding: 'utf8' }).split(/\r?\n/).filter((l) => l.includes('scrcpy_')).length;
  out.hesap = await p.evaluate(() => document.querySelector('#acct')?.innerText.replace(/\s+/g, ' ').slice(0, 120));
  out.sdkKutusu = await p.evaluate(() => (document.querySelector('#sdkBox').hidden ? 'gizli (bileşenler tamam)' : document.querySelector('#sdkBox').innerText.slice(0, 80)));
  out.agCikisSecenekleri = await p.evaluate(() => [...document.querySelectorAll('#proxySel option')].map((o) => o.textContent));
  await p.screenshot({ path: path.join(outDir, 'panel.png') });
  // Güvenlik sekmesi
  await p.click('button[data-tab=guvenlik]');
  await p.waitForTimeout(6000);
  out.guvenlik = await p.evaluate(() => [...document.querySelectorAll('#checks li')].map((li) => `${li.className}: ${li.querySelector('.t').textContent}`));
  await p.screenshot({ path: path.join(outDir, 'panel-guvenlik.png'), clip: { x: 1240, y: 52, width: 360, height: 898 } });
  // Dar ekran
  const m = await b.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  await m.goto(`http://127.0.0.1:${port}/`);
  await m.waitForTimeout(2500);
  out.mobilTasma = (await m.evaluate(() => document.documentElement.scrollWidth)) - 390;
  await m.screenshot({ path: path.join(outDir, 'panel-mobil.png') });
  out.hatalar = errors;
  console.log(JSON.stringify(out, null, 1));
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
