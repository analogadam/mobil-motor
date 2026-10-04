// Hesap şablonu + kopya akışı testi (Google girişi hariç). Pencere açmaz. Sonunda kopyayı siler.
// Kullanım: node qa/sablon-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADB = path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const TEMPLATE = 'MobilMotor-Hesap';
const KLON = 'KlonTest';
const sess = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '.oturum'), 'utf8'));
const B = `http://127.0.0.1:${sess.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => {
  try {
    return execFileSync(ADB, a, { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim();
  } catch {
    return '';
  }
};
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
};
const login = await fetch(`${B}/giris?t=${sess.token}`, { redirect: 'manual' });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
const H = { cookie, origin: B, 'x-mobilmotor': '1', 'content-type': 'application/json' };
const post = (p, body) => fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const serialOf = (name) =>
  adb('devices')
    .split(/\r?\n/)
    .map((l) => l.split(/\s+/)[0])
    .filter((s) => s.startsWith('emulator-'))
    .find((s) => adb('-s', s, 'emu', 'avd', 'name').split(/\r?\n/)[0].trim() === name);
async function acilisBekle(name, ms = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = serialOf(name);
    if (s && adb('-s', s, 'shell', 'getprop', 'sys.boot_completed') === '1') return { serial: s, sn: Math.round((Date.now() - t0) / 1000) };
    await sleep(4000);
  }
  return {};
}
async function kapat(serial) {
  adb('-s', serial, 'emu', 'kill');
  for (let i = 0; i < 60 && serialOf(TEMPLATE) === serial; i++) await sleep(1000);
  // süreç tamamen bitsin
  for (let i = 0; i < 60 && /qemu[^\r\n]*/.test(execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' })) && adb('devices').includes(serial); i++) await sleep(1000);
  await sleep(4000);
}

console.log('== Hesap şablonu (penceresiz)');
let r = await post('/api/emu/start', { names: [TEMPLATE], headless: true });
ok('şablon başlatıldı', r.status === 200, r.json?.error || '');
const t = await acilisBekle(TEMPLATE);
ok('şablon açıldı', !!t.serial, `${t.sn} sn`);
if (!t.serial) process.exit(1);
await sleep(25000); // Türkçe + hafif mod otomatik uygulansın
ok('Türkçe', adb('-s', t.serial, 'shell', 'getprop', 'persist.sys.locale') === 'tr-TR');
ok('saat İstanbul', adb('-s', t.serial, 'shell', 'getprop', 'persist.sys.timezone') === 'Europe/Istanbul');
ok('hafif mod: pil tasarrufu', adb('-s', t.serial, 'shell', 'settings', 'get', 'global', 'low_power') === '1');
ok('hafif mod: iç ekran küçüldü', /Override size/.test(adb('-s', t.serial, 'shell', 'wm', 'size')));
ok('hafif mod: Mesajlar kapalı', adb('-s', t.serial, 'shell', 'pm', 'list', 'packages', '-d').includes('com.google.android.apps.messaging'));
ok('ekran 30 Hz', /fps=30/.test(adb('-s', t.serial, 'shell', 'dumpsys display | grep -m1 fps=')));
ok('Play Store yüklü', adb('-s', t.serial, 'shell', 'pm', 'list', 'packages', 'com.android.vending').includes('com.android.vending'));
adb('-s', t.serial, 'shell', 'monkey', '-p', 'com.android.vending', '-c', 'android.intent.category.LAUNCHER', '1');
await sleep(4000);
ok('Play Store açılıyor (giriş ekranı)', /com\.android\.vending|com\.google\.android\.gms/.test(adb('-s', t.serial, 'shell', 'dumpsys activity activities | grep -m1 topResumedActivity')));
const hesap = await (await fetch(`${B}/api/account`, { headers: { cookie } })).json();
ok('panel şablonu "açık" görüyor', hesap.serial === t.serial);
r = await post('/api/account/save', {});
ok('hesapsız kaydetme reddediliyor (önce giriş gerek)', r.status === 409, r.json?.error);
await kapat(t.serial);
ok('şablon kapandı', !serialOf(TEMPLATE));

console.log('== Şablondan kopya');
const emu = await import('../lib/emulator.js');
await emu.cloneTemplate(KLON, 'phone');
const avdHome = path.join(process.env.USERPROFILE, '.android', 'avd');
const cfg = fs.readFileSync(path.join(avdHome, `${KLON}.avd`, 'config.ini'), 'utf8');
ok('kopya oluştu, ayarlar yeni profille', /hw\.ramSize=4096/.test(cfg) && /hw\.lcd\.vsync=30/.test(cfg) && /AvdId=KlonTest/.test(cfg));
ok('şablonun anlık görüntüsü/kilitleri kopyalanmadı', !fs.existsSync(path.join(avdHome, `${KLON}.avd`, 'snapshots')) && !fs.readdirSync(path.join(avdHome, `${KLON}.avd`)).some((f) => f.endsWith('.lock')));
r = await post('/api/emu/start', { names: [KLON], headless: true });
const k = await acilisBekle(KLON);
ok('kopya açıldı', !!k.serial, `${k.sn} sn`);
if (k.serial) {
  ok('kopya Türkçe (şablondan geldi)', adb('-s', k.serial, 'shell', 'getprop', 'persist.sys.locale') === 'tr-TR');
  ok('kopya 30 Hz', /fps=30/.test(adb('-s', k.serial, 'shell', 'dumpsys display | grep -m1 fps=')));
  await kapat(k.serial);
}
r = await post('/api/emu/delete', { name: KLON });
ok('kopya silindi', r.status === 200 && !fs.existsSync(path.join(avdHome, `${KLON}.avd`)), r.json?.error || '');
console.log(process.exitCode ? 'SONUÇ: BAŞARISIZ' : 'SONUÇ: hepsi geçti');
