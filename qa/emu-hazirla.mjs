// Test emülatörünü panel üzerinden penceresiz başlatır, açılışı bekler, seri numarasını yazar.
// Kullanım: node qa/emu-hazirla.mjs KTest
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AVD = process.argv[2] || 'KTest';
const ADB = path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const sess = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '.oturum'), 'utf8'));
const B = `http://127.0.0.1:${sess.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => {
  try {
    return execFileSync(ADB, a, { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
  } catch {
    return '';
  }
};

const login = await fetch(`${B}/giris?t=${sess.token}`, { redirect: 'manual' });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
const running = () =>
  adb('devices')
    .split(/\r?\n/)
    .map((l) => l.split(/\s+/)[0])
    .filter((s) => s.startsWith('emulator-'))
    .find((s) => adb('-s', s, 'emu', 'avd', 'name').split(/\r?\n/)[0].trim() === AVD);

let serial = running();
if (!serial) {
  const r = await fetch(`${B}/api/emu/start`, {
    method: 'POST',
    headers: { cookie, origin: B, 'x-mobilmotor': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ names: [AVD], headless: true }),
  });
  if (!r.ok) throw new Error(`başlatılamadı: ${await r.text()}`);
}
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  serial = running();
  if (serial && adb('-s', serial, 'shell', 'getprop', 'sys.boot_completed') === '1') break;
  await sleep(3000);
}
if (!serial) throw new Error('emülatör açılmadı');
await sleep(8000); // açılış sonrası yük otursun
console.error(`${AVD} hazır: ${serial} (${Math.round((Date.now() - t0) / 1000)} sn) dil=${adb('-s', serial, 'shell', 'getprop', 'persist.sys.locale')} saat=${adb('-s', serial, 'shell', 'getprop', 'persist.sys.timezone')}`);
console.log(serial);
