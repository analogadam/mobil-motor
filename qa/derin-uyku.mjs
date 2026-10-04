// Derin uyku testi. Sunucu MOBILMOTOR_DERIN_MS=30000 ile açılmış olmalı.
// Kullanım: node qa/derin-uyku.mjs KTest [canlı tutulacak diğer seri...]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [AVD, ...KEEP] = process.argv.slice(2);
const ADB = path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const sess = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '.oturum'), 'utf8'));
const B = `http://127.0.0.1:${sess.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = await fetch(`${B}/giris?t=${sess.token}`, { redirect: 'manual' });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
const H = { cookie, origin: B, 'x-mobilmotor': '1', 'content-type': 'application/json' };
const post = (p, body) => fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const get = (p) => fetch(B + p, { headers: { cookie } }).then((r) => r.json());
const ok = (name, cond, detail = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
const dev = async () => (await get('/api/state')).devices.find((d) => d.label === AVD || d.avd === AVD);

const before = await get('/api/ayarlar');
const d0 = await dev();
if (!d0) throw new Error(`${AVD} açık değil`);
execFileSync(ADB, ['-s', d0.serial, 'shell', 'am', 'start', '-a', 'android.settings.DISPLAY_SETTINGS']);
await sleep(1500);
const topAct = (s) => (execFileSync(ADB, ['-s', s, 'shell', 'dumpsys activity activities'], { encoding: 'utf8' }).match(/topResumedActivity.*?\s([\w.]+\/[\w.$]+)/) || [])[1];
const onceki = topAct(d0.serial);
await post('/api/ayarlar', { uyku: 1 });
await post('/api/ayarlar', { derin: true });
// Diğer emülatörleri canlı tut (testten etkilenmesinler)
const keep = setInterval(() => KEEP.length && post('/api/act', { targets: KEEP, action: { type: 'wait', ms: 0 } }), 20000);

console.log(`== ${AVD}: 1 dk sonra uyku, 30 sn sonra derin uyku bekleniyor (açık ekran: ${onceki})`);
const t0 = Date.now();
let asama = '';
while (Date.now() - t0 < 240000) {
  await sleep(5000);
  const d = await dev();
  if (d?.sleeping && asama !== 'uyku') {
    asama = 'uyku';
    console.log(`  uyudu: ${Math.round((Date.now() - t0) / 1000)} sn`);
  }
  if (!d) {
    asama = 'derin';
    break;
  }
}
ok('uyku → derin uyku (emülatör kapandı)', asama === 'derin', `${Math.round((Date.now() - t0) / 1000)} sn`);
const kayit = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'derin-uyku.json'), 'utf8'))[AVD];
ok('ayarları kaydedildi', !!kayit, JSON.stringify(kayit));
const avd = (await get('/api/emu')).avds.find((a) => a.name === AVD);
ok('panel listesinde "derin uyku" görünüyor', avd?.deep === true);
const qemu = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'qemu*' -and $_.CommandLine -match '-avd ${AVD}( |$)' }).ProcessId`], { encoding: 'utf8' }).trim();
ok('süreç yok → işlemci %0, RAM boş', !qemu);

const t1 = Date.now();
await post('/api/emu/start', { name: AVD });
let d1;
while (Date.now() - t1 < 120000) {
  await sleep(2000);
  d1 = await dev();
  if (d1?.state === 'device') {
    try {
      if (execFileSync(ADB, ['-s', d1.serial, 'shell', 'getprop', 'sys.boot_completed'], { encoding: 'utf8' }).trim() === '1') break;
    } catch {}
  }
}
ok('uyandırıldı', d1?.state === 'device', `${Math.round((Date.now() - t1) / 1000)} sn`);
const sonraki = topAct(d1.serial);
ok('kaldığı yerden devam etti (aynı ekran açık)', sonraki === onceki, sonraki);
ok('derin uyku kaydı temizlendi', !JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'derin-uyku.json'), 'utf8'))[AVD]);
const cmd = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'qemu*' -and $_.CommandLine -match '-avd ${AVD}( |$)' }).CommandLine`], { encoding: 'utf8' });
ok('aynı ayarla açıldı (penceresiz) + yeni RAM', /-no-window/.test(cmd) === !!kayit?.headless, (cmd.match(/-memory \d+/) || ['(config RAM)'])[0]);
execFileSync(ADB, ['-s', d1.serial, 'shell', 'input', 'keyevent', '3']);
clearInterval(keep);
await post('/api/ayarlar', { uyku: before.uyku });
await post('/api/ayarlar', { derin: before.derin });
console.log(`  ayarlar geri alındı: uyku ${before.uyku} dk, derin ${before.derin}`);
