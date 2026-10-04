// Play Store'dan uygulama kurar (Google hesabı açık olmalı): mağaza sayfasını açar, "Yükle"ye basar,
// kurulum bitene kadar bekler. Üçüncü parti APK sitesi kullanılmaz. Root gerekmez.
import { shell, shellRaw } from './adb.js';
import { PKG_RE } from './actions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INSTALL = ['Yükle', 'Install', 'Kur'];
const DONE = ['Aç', 'Open', 'Oyna', 'Play', 'Kaldır', 'Uninstall'];

export const installed = async (serial, pkg) => (await shellRaw(serial, `pm list packages ${pkg}`, { timeout: 10000 }).catch(() => '')).split(/\r?\n/).some((l) => l.trim() === `package:${pkg}`);

// Ekrandaki düğümleri (metin + koordinat) oku
async function nodes(serial) {
  const xml = await shellRaw(serial, 'uiautomator dump /data/local/tmp/mm-ui.xml >/dev/null 2>&1; cat /data/local/tmp/mm-ui.xml; rm -f /data/local/tmp/mm-ui.xml', { timeout: 20000 }).catch(() => '');
  const out = [];
  for (const m of xml.matchAll(/<node\b([^>]*)>/g)) {
    const a = m[1];
    const text = (a.match(/\btext="([^"]*)"/) || [])[1] || '';
    const desc = (a.match(/\bcontent-desc="([^"]*)"/) || [])[1] || '';
    const b = a.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (b) out.push({ text: text || desc, x: Math.round((+b[1] + +b[3]) / 2), y: Math.round((+b[2] + +b[4]) / 2) });
  }
  return out;
}

// onStep: ilerleme mesajı
export async function install(serial, pkg, onStep = () => {}) {
  if (!PKG_RE.test(pkg)) throw new Error('Geçersiz paket adı');
  if (await installed(serial, pkg)) return 'zaten kurulu';
  // Hafif mod Play Store'un arka planda çalışmasını kısıtlar: indirme yarıda kalmasın diye kurulum süresince izin ver
  const onceki = (await shellRaw(serial, 'cmd appops get com.android.vending RUN_ANY_IN_BACKGROUND', { timeout: 10000 }).catch(() => '')).includes('ignore');
  await shellRaw(serial, 'cmd appops set com.android.vending RUN_ANY_IN_BACKGROUND allow', { timeout: 10000 }).catch(() => {});
  try {
    return await kur(serial, pkg, onStep);
  } finally {
    if (onceki) await shellRaw(serial, 'cmd appops set com.android.vending RUN_ANY_IN_BACKGROUND ignore', { timeout: 10000 }).catch(() => {});
  }
}

async function kur(serial, pkg, onStep) {
  onStep('Play Store sayfası açılıyor');
  await shell(serial, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', `market://details?id=${pkg}`, 'com.android.vending']);
  let pressed = false;
  for (let i = 0; i < 20 && !pressed; i++) {
    await sleep(2500);
    const list = await nodes(serial);
    if (list.some((n) => /oturum aç|sign in/i.test(n.text))) throw new Error('Play Store için Google hesabı açık değil');
    const btn = list.find((n) => INSTALL.includes(n.text.trim()));
    if (btn) {
      onStep('"Yükle"ye basılıyor');
      await shell(serial, ['input', 'tap', String(btn.x), String(btn.y)]);
      pressed = true;
    } else if (list.some((n) => DONE.includes(n.text.trim()))) {
      break; // zaten kurulu/kuruluyor
    }
  }
  if (!pressed && !(await installed(serial, pkg))) throw new Error('Play Store\'da "Yükle" düğmesi bulunamadı');
  onStep('İndiriliyor ve kuruluyor');
  const end = Date.now() + 8 * 60000;
  while (Date.now() < end) {
    if (await installed(serial, pkg)) {
      await shell(serial, ['input', 'keyevent', '3']).catch(() => {}); // ana ekrana dön
      return 'kuruldu';
    }
    await sleep(4000);
  }
  throw new Error('Kurulum 8 dakikada bitmedi');
}
