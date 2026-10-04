// "Motoru sıfırla" testi — gerçek sanal cihazlara ve verilere DOKUNMAZ.
// Geçici bir AVD klasörü + geçici veri klasörü kurar, sıfırlamayı orada gerçekten çalıştırır.
// Kullanım: node qa/sifirla-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sifirla-'));
const avdHome = path.join(tmp, 'avd');
const data = path.join(tmp, 'data');
const disari = path.join(tmp, 'disarida-kalmali.txt'); // sıfırlama bunu SİLMEMELİ
fs.mkdirSync(avdHome, { recursive: true });
process.env.ANDROID_AVD_HOME = avdHome; // modüller yüklenmeden önce

const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
};

// Sahte sanal cihazlar
for (const name of ['SahteA', 'SahteB']) {
  fs.mkdirSync(path.join(avdHome, `${name}.avd`), { recursive: true });
  fs.writeFileSync(path.join(avdHome, `${name}.avd`, 'config.ini'), 'hw.ramSize=2048\n');
  fs.writeFileSync(path.join(avdHome, `${name}.avd`, 'userdata-qemu.img.qcow2'), Buffer.alloc(1024 * 1024));
  fs.writeFileSync(path.join(avdHome, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${path.join(avdHome, `${name}.avd`)}\ntarget=android-35\n`);
}
// Sahte veri
for (const d of ['macros', 'captures', 'logs', 'tmp']) fs.mkdirSync(path.join(data, d), { recursive: true });
fs.writeFileSync(path.join(data, 'macros', 'm1.json'), '{}');
fs.writeFileSync(path.join(data, 'captures', 'c1.png'), 'x');
fs.writeFileSync(path.join(data, 'logs', 'kayit.log'), 'x');
fs.writeFileSync(path.join(data, 'proxies.json'), '[{"id":"1"}]');
fs.writeFileSync(path.join(data, 'hesap.json'), '{"email":"x"}');
fs.writeFileSync(path.join(data, 'ayarlar.json'), '{"uyku":3}');
fs.writeFileSync(path.join(data, 'derin-uyku.json'), '{}');
fs.writeFileSync(path.join(data, '.oturum'), 'OTURUM');
fs.writeFileSync(path.join(data, '.anahtar'), 'ANAHTAR');
fs.writeFileSync(disari, 'dokunulmamalı');

const sifirla = await import('../lib/sifirla.js');
const plan = await sifirla.plan(data);
ok('plan sahte sanal cihazları gösteriyor', plan.avds.map((a) => a.name).sort().join(',') === 'SahteA,SahteB', plan.avds.map((a) => a.name).join(','));
ok('plan makro/ağ çıkışı/hesap sayıyor', plan.makro === 1 && plan.agCikisi === 1 && plan.hesap === true);

// Cihazsız sahte hub ve akış yöneticisi: hiçbir gerçek cihaza komut gitmez
const hub = { devices: new Map(), poll: async () => {} };
const streams = { stopAll: () => {} };
const r = await sifirla.run({ dataDir: data, hub, streams, log: (m) => console.log('   log:', m) });

ok('iki sahte sanal cihaz silindi', r.silinen.sort().join(',') === 'SahteA,SahteB', r.silinen.join(','));
ok('AVD klasörü boş', fs.readdirSync(avdHome).length === 0, fs.readdirSync(avdHome).join(',') || 'boş');
const kalan = fs.readdirSync(data).sort();
ok('oturum dosyaları korundu', fs.readFileSync(path.join(data, '.oturum'), 'utf8') === 'OTURUM' && fs.readFileSync(path.join(data, '.anahtar'), 'utf8') === 'ANAHTAR');
ok('veri silindi, boş klasörler yeniden kuruldu', kalan.join(',') === '.anahtar,.oturum,captures,logs,macros,tmp', kalan.join(','));
ok('klasörlerin içi boş', ['macros', 'captures', 'logs'].every((d) => fs.readdirSync(path.join(data, d)).length === 0));
ok('dışarıdaki dosyaya dokunulmadı', fs.existsSync(disari));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? 'SONUÇ: BAŞARISIZ' : 'SONUÇ: hepsi geçti');
