// Açık tüm emülatörleri kapatıp aynı pencere tercihiyle, SIRAYLA yeniden başlatır (yeni ayarlar için).
// Kullanım: node qa/yeniden-baslat.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADB = path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const sess = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '.oturum'), 'utf8'));
const B = `http://127.0.0.1:${sess.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => {
  try {
    return execFileSync(ADB, a, { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
  } catch {
    return '';
  }
};
const login = await fetch(`${B}/giris?t=${sess.token}`, { redirect: 'manual' });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
const H = { cookie, origin: B, 'x-mobilmotor': '1', 'content-type': 'application/json' };

const emus = adb('devices')
  .split(/\r?\n/)
  .map((l) => l.split(/\s+/)[0])
  .filter((s) => s.startsWith('emulator-'))
  .map((s) => ({ serial: s, name: adb('-s', s, 'emu', 'avd', 'name').split(/\r?\n/)[0].trim(), headless: /headless/i.test(adb('-s', s, 'emu', 'avd', 'windowtype')) }));
console.log('yeniden başlatılacak:', emus.map((e) => `${e.name}${e.headless ? '' : ' (pencereli)'}`).join(', '));

for (const e of emus) adb('-s', e.serial, 'emu', 'kill');
for (let i = 0; i < 30 && adb('devices').includes('emulator-'); i++) await sleep(1000);
console.log('hepsi kapandı');
await sleep(2000);

const t0 = Date.now();
for (const e of emus) {
  const r = await fetch(`${B}/api/emu/start`, { method: 'POST', headers: H, body: JSON.stringify({ names: [e.name], headless: e.headless }) });
  console.log(`  ${e.name}: ${r.status === 200 ? 'kuyruğa alındı' : await r.text()}`);
}
// Hepsi açılana kadar bekle
const acik = () =>
  adb('devices')
    .split(/\r?\n/)
    .map((l) => l.split(/\s+/)[0])
    .filter((s) => s.startsWith('emulator-') && adb('-s', s, 'shell', 'getprop', 'sys.boot_completed') === '1');
let last = -1;
while (Date.now() - t0 < 900000) {
  const n = acik().length;
  if (n !== last) {
    console.log(`  ${Math.round((Date.now() - t0) / 1000)} sn: ${n}/${emus.length} açık`);
    last = n;
  }
  if (n >= emus.length) break;
  await sleep(5000);
}
for (const s of acik()) {
  const name = adb('-s', s, 'emu', 'avd', 'name').split(/\r?\n/)[0].trim();
  const hz = (adb('-s', s, 'shell', 'dumpsys display | grep -m1 fps=').match(/fps=([\d.]+)/) || [, '?'])[1];
  console.log(`  ${s} ${name}: ekran ${hz} Hz, ${adb('-s', s, 'shell', 'wm', 'size').split(/\r?\n/).pop()}`);
}
