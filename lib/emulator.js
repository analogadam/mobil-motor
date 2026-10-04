import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { SDK_ROOT, EMULATOR, run, adb, sdkEnv } from './adb.js';
import { HttpError, sleep } from './util.js';

const AVD_HOME = process.env.ANDROID_AVD_HOME || path.join(os.homedir(), '.android', 'avd');
export const AVD_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/; // nokta ile başlayamaz
export const TEMPLATE = 'MobilMotor-Hesap';
const LOCALE = 'tr-TR';
const TIMEZONE = 'Europe/Istanbul';
const LOCALE_MARK = 'mobilmotor-dil.txt';
const VSYNC = 30; // ekran yenileme hızı (Hz)

export const PROFILES = {
  phone: { label: 'Telefon', width: 1080, height: 2400, density: 420, ram: 4096 },
  tablet: { label: 'Tablet', width: 1600, height: 2560, density: 320, ram: 6144 },
  small: { label: 'Küçük telefon', width: 720, height: 1600, density: 320, ram: 3072 },
};

const avdDir = (name) => path.join(AVD_HOME, `${name}.avd`);
const iniFile = (name) => path.join(AVD_HOME, `${name}.ini`);

export function systemImages() {
  const base = path.join(SDK_ROOT, 'system-images');
  const out = [];
  for (const api of safeReaddir(base)) {
    for (const tag of safeReaddir(path.join(base, api))) {
      const dir = path.join(base, api, tag, 'x86_64');
      if (fs.existsSync(path.join(dir, 'system.img'))) {
        out.push({ id: `${api}/${tag}`, api, tag, level: Number(api.replace(/\D/g, '')) || 0, rel: `system-images\\${api}\\${tag}\\x86_64\\` });
      }
    }
  }
  // En yeni API; aynı seviyede Play Store'lu olan önce
  return out.sort((a, b) => b.level - a.level || (b.tag.includes('playstore') ? 1 : 0) - (a.tag.includes('playstore') ? 1 : 0));
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export async function listAvds() {
  if (!fs.existsSync(EMULATOR)) return [];
  const out = await run(EMULATOR, ['-list-avds'], { timeout: 15000, env: sdkEnv() }).catch(() => '');
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => AVD_RE.test(s));
}

function checkNew(name) {
  if (!AVD_RE.test(name)) throw new HttpError(400, 'İsim yalnızca harf, rakam, _ . - içerebilir (en çok 40)');
  if (fs.existsSync(avdDir(name)) || fs.existsSync(iniFile(name))) throw new HttpError(409, `Bu isimde sanal cihaz zaten var: ${name}`);
}

async function writeConfig(name, profile, img) {
  const playstore = img.tag.includes('playstore');
  const config = {
    AvdId: name,
    'avd.ini.displayname': name,
    'avd.ini.encoding': 'UTF-8',
    'abi.type': 'x86_64',
    'hw.cpu.arch': 'x86_64',
    'hw.cpu.ncore': 2,
    'hw.ramSize': profile.ram,
    'disk.dataPartition.size': '8G',
    'image.sysdir.1': img.rel,
    'tag.id': img.tag,
    'tag.display': playstore ? 'Google Play' : img.tag,
    'PlayStore.enabled': playstore ? 'true' : 'false',
    'hw.lcd.width': profile.width,
    'hw.lcd.height': profile.height,
    'hw.lcd.density': profile.density,
    'hw.lcd.vsync': VSYNC, // 30 Hz: ekran ve video çizimi yarı sıklıkta (işlemci tasarrufu)
    'hw.keyboard': 'yes',
    'hw.mainKeys': 'no',
    'hw.gpu.enabled': 'yes',
    'hw.gpu.mode': 'host',
    'hw.accelerometer': 'yes',
    'hw.gps': 'yes',
    'hw.sdCard': 'no',
    showDeviceFrame: 'no',
    // Gizlilik: bilgisayarın kamerası ve mikrofonu sanal cihaza hiç bağlanmaz
    'hw.camera.back': 'none',
    'hw.camera.front': 'none',
    'hw.audioInput': 'no',
    'fastboot.forceColdBoot': 'no',
  };
  await fsp.writeFile(path.join(avdDir(name), 'config.ini'), Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  await fsp.writeFile(iniFile(name), ['avd.ini.encoding=UTF-8', `path=${avdDir(name)}`, `path.rel=avd\\${name}.avd`, `target=${img.api}`].join('\n') + '\n');
}

function pickImage(imageId) {
  const images = systemImages();
  const img = imageId ? images.find((i) => i.id === imageId) : images[0];
  if (!img) throw new HttpError(400, 'Kurulu x86_64 sistem imajı yok');
  return img;
}

export async function create(name, profileKey, imageId) {
  checkNew(name);
  const profile = PROFILES[profileKey];
  if (!profile) throw new HttpError(400, 'Geçersiz profil');
  const img = pickImage(imageId);
  await fsp.mkdir(avdDir(name), { recursive: true });
  await writeConfig(name, profile, img);
  return { name, profile: profileKey, image: img.id };
}

// Hesap şablonundan kopya: Google hesabı ve Türkçe ayar hazır gelir.
// Anlık görüntü (snapshot), kilit ve çalışma anı dosyaları kopyalanmaz; kopya temiz açılır.
const SKIP = new Set(['snapshots', 'tmpAdbCmds', 'hardware-qemu.ini', 'emu-launch-params.txt', 'read-snapshot.txt', 'bootcompleted.ini', 'multiinstance.lock', 'emulator-user.ini', 'AVD.conf', 'quickbootChoice.ini', 'config.ini']);
export async function cloneTemplate(name, profileKey) {
  checkNew(name);
  const profile = PROFILES[profileKey];
  if (!profile) throw new HttpError(400, 'Geçersiz profil');
  const src = avdDir(TEMPLATE);
  if (!fs.existsSync(path.join(src, 'userdata-qemu.img.qcow2'))) throw new HttpError(409, 'Hesap şablonu hazır değil');
  const img = pickImage(await templateImage());
  await fsp.cp(src, avdDir(name), {
    recursive: true,
    filter: (p) => {
      const base = path.basename(p);
      return !SKIP.has(base) && !base.endsWith('.lock');
    },
  });
  await writeConfig(name, profile, img);
  return { name, profile: profileKey, image: img.id, fromTemplate: true };
}

async function templateImage() {
  try {
    const cfg = await fsp.readFile(path.join(avdDir(TEMPLATE), 'config.ini'), 'utf8');
    const m = cfg.match(/^image\.sysdir\.1=system-images\\([^\\]+)\\([^\\]+)\\/m);
    return m ? `${m[1]}/${m[2]}` : undefined;
  } catch {
    return undefined;
  }
}

export async function ensureTemplate() {
  if (!(await listAvds()).includes(TEMPLATE)) {
    const img = systemImages().find((i) => i.tag.includes('playstore'));
    if (!img) throw new HttpError(400, 'Play Store\'lu sistem imajı kurulu değil');
    await create(TEMPLATE, 'phone', img.id);
  }
}

// Emülatör belleği (MB). "otomatik": 24 GB'tan az RAM'li makinede telefon 3 GB, tablet 4 GB
// (16 GB'ta 5 × 4 GB belleği taşırıyordu). Daha azı Android'in içini sıkıştırmayla boğuyor.
export const DUSUK_RAM = os.totalmem() < 24 * 1024 ** 3;
export function ramFor(name, secim = 'otomatik') {
  let w = 0;
  try {
    w = Number(fs.readFileSync(path.join(avdDir(name), 'config.ini'), 'utf8').match(/^hw\.lcd\.width=(\d+)/m)?.[1] || 0);
  } catch {}
  const tablet = w >= 1500;
  if (secim === 3072) return tablet ? 4096 : 3072;
  if (secim === 4096) return tablet ? 6144 : 4096;
  if (w && w <= 800) return 3072;
  if (DUSUK_RAM) return tablet ? 4096 : 3072;
  return tablet ? 6144 : 4096;
}

export async function start(name, { headless = false, logDir, proxy = null, ram = 0 } = {}) {
  const avds = await listAvds();
  if (!avds.includes(name)) throw new HttpError(404, `Sanal cihaz yok: ${name}`);
  const logFile = path.join(logDir, `emulator-${name}.log`);
  const out = fs.openSync(logFile, 'w');
  // Gizlilik: kullanım verisi ve çökme raporu Google'a hiç gönderilmez
  // Performans: ekran çizimi ekran kartında (-gpu host), işlemcide yazılımsal değil; 2 çekirdek
  const args = ['-avd', name, '-no-metrics', '-crash-report-mode', 'disabled', '-no-boot-anim', '-timezone', proxy?.tz || TIMEZONE, '-gpu', 'host', '-cores', '2'];
  // Ekran yenileme 30 Hz: eski AVD'lerin ayarı da açılışta güncellenir (ilk seferde soğuk açılış olur)
  try {
    const cfgFile = path.join(avdDir(name), 'config.ini');
    const cfg = fs.readFileSync(cfgFile, 'utf8');
    if (!new RegExp(`^hw\\.lcd\\.vsync=${VSYNC}$`, 'm').test(cfg)) {
      const next = /^hw\.lcd\.vsync=.*$/m.test(cfg) ? cfg.replace(/^hw\.lcd\.vsync=.*$/m, `hw.lcd.vsync=${VSYNC}`) : cfg.trimEnd() + `\nhw.lcd.vsync=${VSYNC}\n`;
      fs.writeFileSync(cfgFile, next);
    }
  } catch {}
  // Bellek: her açılışta seçilen değer verilir (config.ini'deki eski değer ne olursa olsun).
  // Play Store'lu Android 2 GB'ta sıkışıp işlemciyi yoruyor (kcompactd); en az 3 GB.
  args.push('-memory', String(ram || ramFor(name)));
  if (headless) args.push('-no-window', '-no-audio'); // penceresizde ses emülasyonu gereksiz yük
  // detached değil: emülatör MobilMotor'un gizli konsolunu paylaşır, ayrı cmd penceresi açılmaz.
  // Emülatör penceresi kapanınca o konsol da onunla birlikte gider.
  // Ağ çıkışı: tüm TCP bağlantıları bu HTTP proxy'den çıkar. Komut satırı yerine ortam değişkeni:
  // emülatör komut satırını AVD klasörüne düz metin yazar, şifre oraya düşmesin.
  const env = sdkEnv();
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  if (proxy) env.http_proxy = proxy.url;
  const child = spawn(EMULATOR, args, { stdio: ['ignore', out, out], env });
  fs.closeSync(out);
  // İlk saniyelerde kapanırsa hatayı kullanıcıya göster
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 6000);
    child.once('error', (e) => (clearTimeout(timer), reject(new HttpError(500, `Emülatör başlatılamadı: ${e.message}`))));
    child.once('exit', () => {
      clearTimeout(timer);
      const tail = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter((l) => /error|fatal|could not|failed/i.test(l)).slice(-3).join(' | ');
      reject(new HttpError(500, `${name} açılamadı: ${tail || 'bilinmeyen hata'} (ayrıntı: data/logs/emulator-${name}.log)`));
    });
  });
  child.unref();
}

// Türkçe: emülatörün kendi -change-locale seçeneği root ister (Play Store imajlarında yok).
// Onun yerine küçük yardımcı (tools/dil) "shell" kullanıcısının CHANGE_CONFIGURATION izniyle
// sistem dilini ayarlar. Yalnızca ilk açılışta; ayar kalıcıdır, şablon kopyaları da devralır.
export const localeDone = (name) => fs.existsSync(path.join(avdDir(name), LOCALE_MARK));
export async function applyLocale(name, serial, dexPath) {
  if (localeDone(name)) return false;
  const remote = '/data/local/tmp/mm-dil.dex';
  await adb(['-s', serial, 'push', dexPath, remote], { timeout: 20000 });
  const out = await adb(['-s', serial, 'shell', `CLASSPATH=${remote} app_process / Dil ${LOCALE}; rm -f ${remote}`], { timeout: 20000 });
  if (!out.includes(`dil: ${LOCALE}`)) throw new Error(`dil ayarlanamadı: ${out.trim().slice(0, 200)}`);
  fs.writeFileSync(path.join(avdDir(name), LOCALE_MARK), LOCALE);
  return true;
}

export async function stop(serial) {
  if (!/^emulator-\d{4,5}$/.test(serial)) throw new HttpError(400, 'Yalnızca emülatörler kapatılabilir');
  await adb(['-s', serial, 'emu', 'kill'], { timeout: 15000 });
}

// Emülatör tamamen kapanana kadar bekle (dosyalar diske yazılsın)
export async function waitGone(hub, serial, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await hub.poll();
    if (!hub.devices.has(serial)) {
      await sleep(3000);
      return;
    }
    await sleep(1000);
  }
  throw new HttpError(500, 'Sanal cihaz zamanında kapanmadı');
}

export async function remove(name, runningNames) {
  if (!AVD_RE.test(name)) throw new HttpError(400, 'Geçersiz isim');
  if (runningNames.includes(name)) throw new HttpError(409, 'Önce sanal cihazı kapat');
  const avds = await listAvds();
  if (!avds.includes(name)) throw new HttpError(404, 'Sanal cihaz yok');
  // Sadece AVD klasörünün içindeki bu cihaza ait dosyalar silinir
  if (path.dirname(avdDir(name)) !== AVD_HOME) throw new HttpError(400, 'Geçersiz yol');
  await fsp.rm(avdDir(name), { recursive: true, force: true });
  await fsp.rm(iniFile(name), { force: true });
}
