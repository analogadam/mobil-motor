// Hafif mod: emülatörlerde işlemci/bellek tüketimini düşürür. Her açılışta bir kez uygulanır.
// Hiçbiri root istemez; hepsi geri alınabilir (panelde "Hafif mod" kapatılınca geri alınır).
// Açık uygulamalar KAPATILMAZ (kullanıcının açtığı Chrome vb. kapanmasın); yalnızca arka plana
// geçtiklerinde kendi kendilerine çalışmaları engellenir.
import { shellRaw } from './adb.js';

// Emülatörde gereksiz, arka planda sürekli iş yapan uygulamalar: tamamen kapatılır
export const DISABLE = [
  'com.google.android.apps.messaging', // SMS yok; açılışta "yanıt vermiyor" uyarısının kaynağı
  'com.google.android.apps.wellbeing',
  'com.google.android.apps.restore',
  'com.google.android.apps.tachyon',
];

// Kullanılabilir kalır ama ARKA PLANDA kendi kendine çalışamaz (otomatik güncelleme, senkron vb.)
export const NO_BACKGROUND = [
  'com.android.vending',
  'com.google.android.googlequicksearchbox',
  'com.google.android.as.oss',
  'com.google.android.as',
  'com.google.android.apps.photos',
  'com.google.android.youtube',
  'com.google.android.apps.youtube.music',
  'com.google.android.gm',
  'com.google.android.apps.maps',
  'com.android.chrome',
  'com.google.android.apps.docs',
  'com.google.android.calendar',
  'com.google.android.videos',
];

// İç ekran çözünürlüğü 2/3: çizim (arayüz, video) işi yarıdan fazla azalır. Görüntü oranı korunur.
function lighterDisplay(wmSize, wmDensity) {
  const size = wmSize.match(/Physical size:\s*(\d+)x(\d+)/);
  const dens = wmDensity.match(/Physical density:\s*(\d+)/);
  if (!size || !dens) return [];
  const w = Number(size[1]);
  const h = Number(size[2]);
  if (Math.min(w, h) <= 800) return []; // zaten küçük
  const even = (n) => Math.round(n / 2) * 2;
  return [`wm size ${even((w * 2) / 3)}x${even((h * 2) / 3)}`, `wm density ${Math.round((Number(dens[1]) * 2) / 3)}`];
}

export async function apply(serial) {
  const SEP = '__MM__';
  const [pkgs, wmSize, wmDensity] = (await shellRaw(serial, `pm list packages; echo ${SEP}; wm size; echo ${SEP}; wm density`, { timeout: 15000 })).split(SEP);
  const installed = new Set(pkgs.split(/\r?\n/).map((l) => l.replace('package:', '').trim()));
  const cmds = [
    // Animasyonlar kapalı: çizim yükü düşer
    'settings put global window_animation_scale 0',
    'settings put global transition_animation_scale 0',
    'settings put global animator_duration_scale 0',
    // Arka plandaki "... yanıt vermiyor" pencereleri çıkmasın
    'settings put global hide_error_dialogs 1',
    // Pil tasarrufu: arka plan işleri ve senkron kısılır (emülatörü "şarjda değil" say)
    'dumpsys battery unplug',
    'settings put global low_power 1',
    // "Şarjda değil" sayılınca ekran kapanıp panelde siyah görünüyordu: ekran hep açık, kilit ekranı yok
    'settings put system screen_off_timeout 2147483647',
    'locksettings set-disabled true >/dev/null 2>&1',
    'input keyevent 224',
    'wm dismiss-keyguard',
    ...lighterDisplay(wmSize, wmDensity),
    ...DISABLE.filter((p) => installed.has(p)).map((p) => `pm disable-user --user 0 ${p} >/dev/null 2>&1`),
    // Açık olan uygulamaya dokunmaz; yalnızca arka plandaki çalışma izni kalkar
    ...NO_BACKGROUND.filter((p) => installed.has(p)).map((p) => `cmd appops set ${p} RUN_ANY_IN_BACKGROUND ignore`),
    'echo hafif-tamam',
  ];
  const out = await shellRaw(serial, cmds.join('; '), { timeout: 60000 });
  if (!out.includes('hafif-tamam')) throw new Error('hafif mod uygulanamadı');
}

export async function revert(serial) {
  const cmds = [
    'settings put global window_animation_scale 1',
    'settings put global transition_animation_scale 1',
    'settings put global animator_duration_scale 1',
    'settings put global hide_error_dialogs 0',
    'settings put global low_power 0',
    'dumpsys battery reset',
    'settings put system screen_off_timeout 600000',
    'wm size reset',
    'wm density reset',
    ...DISABLE.map((p) => `pm enable ${p} >/dev/null 2>&1`),
    ...NO_BACKGROUND.map((p) => `cmd appops set ${p} RUN_ANY_IN_BACKGROUND allow >/dev/null 2>&1`),
    'echo geri-tamam',
  ];
  await shellRaw(serial, cmds.join('; '), { timeout: 60000 });
}
