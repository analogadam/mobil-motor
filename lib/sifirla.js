// "Motoru sıfırla": MobilMotor'u ilk kurulum haline getirir.
// Silinir: tüm sanal cihazlar (AVD), makrolar, ekran görüntüleri, kayıtlar, ağ çıkışları, Google hesap şablonu bilgisi, ayarlar.
// Silinmez: Android SDK (Android Studio ile ortak), telefonlardaki kullanıcı verisi, oturum anahtarı (panel açık kalsın).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { adb, shellRaw, run as calistir } from './adb.js';
import * as emu from './emulator.js';

const KEEP = new Set(['.oturum', '.anahtar']);

async function dirSize(p) {
  let n = 0;
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else n += (await fsp.stat(f).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(p);
  return n;
}

// Silinmeden önce kullanıcıya gösterilecek liste
export async function plan(dataDir) {
  const avds = await emu.listAvds();
  const avdHome = process.env.ANDROID_AVD_HOME || path.join(process.env.USERPROFILE, '.android', 'avd');
  const avdList = [];
  for (const name of avds) avdList.push({ name, mb: Math.round((await dirSize(path.join(avdHome, `${name}.avd`))) / 1048576) });
  const count = async (sub) => (await fsp.readdir(path.join(dataDir, sub)).catch(() => [])).length;
  return {
    avds: avdList,
    makro: await count('macros'),
    goruntu: await count('captures'),
    kayit: await count('logs'),
    agCikisi: fs.existsSync(path.join(dataDir, 'proxies.json')) ? JSON.parse(fs.readFileSync(path.join(dataDir, 'proxies.json'), 'utf8')).length : 0,
    hesap: fs.existsSync(path.join(dataDir, 'hesap.json')),
  };
}

export async function run({ dataDir, hub, streams, log }) {
  // 1) Akışları ve emülatörleri kapat
  streams.stopAll();
  const emus = [...hub.devices.values()].filter((d) => d.transport === 'emulator');
  for (const d of emus) await adb(['-s', d.serial, 'emu', 'kill'], { timeout: 15000 }).catch(() => {});
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    await hub.poll();
    if (![...hub.devices.values()].some((d) => d.transport === 'emulator')) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Emülatörler kapanırken durumlarını diske yazar: süreçler tamamen bitene kadar bekle (dosyalar kilitli kalmasın)
  const qemuVar = async () => /qemu-system/i.test(await calistir('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 15000 }).catch(() => ''));
  const bitis = Date.now() + 90000;
  while (Date.now() < bitis && emus.length && (await qemuVar())) await new Promise((r) => setTimeout(r, 1500));
  await new Promise((r) => setTimeout(r, 1000));

  // 2) Sanal cihazları sil (dosya hâlâ kilitliyse birkaç kez dene)
  const silinen = [];
  for (const name of await emu.listAvds()) {
    for (let deneme = 1; deneme <= 5; deneme++) {
      try {
        await emu.remove(name, []);
        silinen.push(name);
        break;
      } catch (e) {
        if (deneme === 5) log(`silinemedi: ${name} — ${e.message}`);
        else await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // 3) Telefonlardan MobilMotor'un geçici dosyalarını kaldır (kullanıcı verisine dokunulmaz)
  for (const d of hub.devices.values()) {
    if (d.state !== 'device') continue;
    await shellRaw(d.serial, 'rm -f /data/local/tmp/mobilmotor-*', { timeout: 10000 }).catch(() => {});
  }

  // 4) Veri klasörü: oturum dosyaları hariç her şey
  for (const e of await fsp.readdir(dataDir, { withFileTypes: true })) {
    if (KEEP.has(e.name)) continue;
    await fsp.rm(path.join(dataDir, e.name), { recursive: true, force: true });
  }
  for (const d of ['macros', 'captures', 'logs', 'tmp']) await fsp.mkdir(path.join(dataDir, d), { recursive: true });
  return { silinen };
}
