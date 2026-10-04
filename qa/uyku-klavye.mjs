// Otomatik uyku + klavye/pano testi (yalnızca verilen emülatörde).
// Kullanım: node qa/uyku-klavye.mjs emulator-5554
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMU = process.argv[2];
if (!EMU?.startsWith('emulator-')) throw new Error('Bir emülatör seri numarası ver');
const sess = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '.oturum'), 'utf8'));
const B = `http://127.0.0.1:${sess.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = await fetch(`${B}/giris?t=${sess.token}`, { redirect: 'manual' });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
const H = { cookie, origin: B, 'x-mobilmotor': '1', 'content-type': 'application/json' };
const post = async (p, body) => {
  const r = await fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const state = async () => (await (await fetch(`${B}/api/state`, { headers: { cookie } })).json()).devices.find((d) => d.serial === EMU);
const qemu = () => {
  const avd = execFileSync(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'), ['-s', EMU, 'emu', 'avd', 'name'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'qemu*' -and $_.CommandLine -match '-avd ${avd}( |$)' }).ProcessId`], { encoding: 'utf8' }).trim();
};
const cpu = (pid, s = 10) =>
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `$a=(Get-Process -Id ${pid}).CPU; Start-Sleep ${s}; $b=(Get-Process -Id ${pid}).CPU; [math]::Round(($b-$a)/${s}*100/[Environment]::ProcessorCount,1)`], { encoding: 'utf8' }).trim();
const ok = (name, cond, detail = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);

const before = (await (await fetch(`${B}/api/ayarlar`, { headers: { cookie } })).json()).uyku;
const pid = qemu();

console.log('== Klavye ve pano (canlı kanal gerekir)');
const ac = new AbortController();
fetch(`${B}/api/d/${EMU}/stream`, { headers: { cookie }, signal: ac.signal }).then((r) => r.body.getReader().read()).catch(() => {});
await sleep(3000);
const metin = 'Merhaba çğşıöü İĞŞ 👍';
ok('Türkçe metin yapıştırıldı (panoya yaz + yapıştır)', (await post(`/api/d/${EMU}/control`, { t: 'paste', text: metin })).status === 200);
const kopya = await post(`/api/d/${EMU}/control`, { t: 'copy' });
ok('cihaz panosu geri okundu, Türkçe bozulmadı', kopya.json?.text === metin, JSON.stringify(kopya.json?.text));
ok('ASCII yazı (text)', (await post(`/api/d/${EMU}/control`, { t: 'text', text: 'abc 123' })).status === 200);
ok('Ctrl+A (keycode + meta)', (await post(`/api/d/${EMU}/control`, { t: 'keycode', code: 29, meta: 0x3000 })).status === 200);
ok('Backspace', (await post(`/api/d/${EMU}/control`, { t: 'keycode', code: 67 })).status === 200);
ok('geçersiz tuş kodu reddedilir', (await post(`/api/d/${EMU}/control`, { t: 'keycode', code: 99999 })).status === 400);
ok('300+ karakter text reddedilir', (await post(`/api/d/${EMU}/control`, { t: 'text', text: 'x'.repeat(301) })).status === 400);
await post(`/api/d/${EMU}/control`, { t: 'key', key: 'home' });
ac.abort();

console.log('== Otomatik uyku');
await post('/api/ayarlar', { uyku: 1 });
const acik = cpu(pid);
console.log(`  bekleniyor: 1 dk hiçbir şey yapılmayacak…`);
let slept = false;
for (let i = 0; i < 20 && !slept; i++) {
  await sleep(6000);
  slept = !!(await state())?.sleeping;
}
ok('1 dk kullanılmayınca uyutuldu', slept);
const uyku = cpu(pid);
ok('uykuda işlemci düştü', Number(uyku.replace(',', '.')) < Number(acik.replace(',', '.')), `açık %${acik} → uykuda %${uyku}`);
const scr = await fetch(`${B}/api/d/${EMU}/screen`, { headers: { cookie } });
ok('küçük resim isteği uyandırmaz (409)', scr.status === 409 && (await state()).sleeping);
const t0 = Date.now();
const r = await post('/api/act', { targets: [EMU], action: { type: 'key', key: 'home' } });
ok('bir eylem gönderince uyandı ve eylem çalıştı', r.status === 200 && r.json.results[0].ok && !(await state()).sleeping, `${Date.now() - t0} ms`);
await post('/api/ayarlar', { uyku: before });
console.log(`  uyku ayarı geri alındı: ${before} dk`);
