import { shell, shellRaw, adb } from './adb.js';
import { HttpError, sleep } from './util.js';

export const KEYS = {
  back: 4,
  home: 3,
  recents: 187,
  power: 26,
  wakeup: 224,
  sleep: 223,
  volup: 24,
  voldown: 25,
  mute: 164,
  enter: 66,
  del: 67,
  tab: 61,
  menu: 82,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  playpause: 85,
};

export const PKG_RE = /^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/;

const unit = (v, name = 'koordinat') => {
  const x = Number(v);
  if (!Number.isFinite(x) || x < 0 || x > 1) throw new HttpError(400, `Geçersiz ${name}`);
  return x;
};

const int = (v, lo, hi, def, name) => {
  if (v === undefined || v === null) return def;
  const x = Math.round(Number(v));
  if (!Number.isFinite(x) || x < lo || x > hi) throw new HttpError(400, `Geçersiz ${name} (${lo}–${hi})`);
  return x;
};

const str = (v, max, name) => {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new HttpError(400, `Geçersiz ${name}`);
  return v;
};

const pkg = (v) => {
  if (typeof v !== 'string' || v.length > 200 || !PKG_RE.test(v)) throw new HttpError(400, 'Geçersiz paket adı');
  return v;
};

// Gelen her eylemi tip tip doğrular; tanımsız alan geçmez. Makrolar da buradan geçer.
export function validate(a) {
  if (!a || typeof a !== 'object') throw new HttpError(400, 'Geçersiz eylem');
  const out = { type: a.type };
  switch (a.type) {
    case 'tap':
      out.x = unit(a.x);
      out.y = unit(a.y);
      break;
    case 'longpress':
      out.x = unit(a.x);
      out.y = unit(a.y);
      out.ms = int(a.ms, 300, 10000, 700, 'süre');
      break;
    case 'swipe':
      out.x1 = unit(a.x1);
      out.y1 = unit(a.y1);
      out.x2 = unit(a.x2);
      out.y2 = unit(a.y2);
      out.ms = int(a.ms, 30, 10000, 300, 'süre');
      break;
    case 'key':
      if (typeof a.key !== 'string' || !Object.hasOwn(KEYS, a.key)) throw new HttpError(400, 'Geçersiz tuş');
      out.key = a.key;
      break;
    case 'text':
      out.text = str(a.text, 1000, 'metin');
      if (!/^[\x20-\x7E]*$/.test(out.text))
        throw new HttpError(400, 'Metin gönderme yalnızca İngilizce karakterleri destekler (ç, ğ, ş… için scrcpy penceresine yapıştır)');
      break;
    case 'launch':
    case 'stop':
    case 'clear':
    case 'uninstall':
      out.pkg = pkg(a.pkg);
      break;
    case 'url': {
      const u = str(a.url, 2000, 'adres');
      let parsed;
      try {
        parsed = new URL(u);
      } catch {
        throw new HttpError(400, 'Geçersiz adres');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'Yalnızca http/https adresleri');
      out.url = parsed.href;
      break;
    }
    case 'notifications':
    case 'rotate':
      break;
    case 'shell':
      out.cmd = str(a.cmd, 4000, 'komut');
      break;
    case 'wait':
      out.ms = int(a.ms, 0, 600000, 1000, 'bekleme');
      break;
    default:
      throw new HttpError(400, 'Bilinmeyen eylem');
  }
  const delay = int(a.delay, 0, 600000, 0, 'gecikme');
  if (delay) out.delay = delay;
  return out;
}

// Kayıt defterine yazılacak özet. Yazılan metin ASLA kaydedilmez (şifre olabilir).
export function describe(a) {
  switch (a.type) {
    case 'tap':
      return `dokun ${a.x.toFixed(3)},${a.y.toFixed(3)}`;
    case 'longpress':
      return `uzun bas ${a.x.toFixed(3)},${a.y.toFixed(3)}`;
    case 'swipe':
      return `kaydır ${a.x1.toFixed(2)},${a.y1.toFixed(2)} → ${a.x2.toFixed(2)},${a.y2.toFixed(2)}`;
    case 'key':
      return `tuş ${a.key}`;
    case 'text':
      return `metin (${a.text.length} karakter, içerik kaydedilmez)`;
    case 'url': {
      const u = new URL(a.url);
      return `adres aç ${u.origin}${u.pathname}`;
    }
    case 'shell':
      return `kabuk: ${a.cmd.slice(0, 200)}`;
    case 'wait':
      return `bekle ${a.ms} ms`;
    default:
      return a.pkg ? `${a.type} ${a.pkg}` : a.type;
  }
}

export async function execute(hub, serial, a) {
  const px = async (x, y) => {
    const { w, h } = await hub.dims(serial);
    return [String(Math.round(x * (w - 1))), String(Math.round(y * (h - 1)))];
  };
  switch (a.type) {
    case 'tap':
      return shell(serial, ['input', 'tap', ...(await px(a.x, a.y))]);
    case 'longpress': {
      const p = await px(a.x, a.y);
      return shell(serial, ['input', 'swipe', ...p, ...p, String(a.ms)]);
    }
    case 'swipe':
      return shell(serial, ['input', 'swipe', ...(await px(a.x1, a.y1)), ...(await px(a.x2, a.y2)), String(a.ms)]);
    case 'key':
      return shell(serial, ['input', 'keyevent', String(KEYS[a.key])]);
    case 'text':
      return shell(serial, ['input', 'text', a.text.replace(/ /g, '%s')]);
    case 'launch':
      return shell(serial, ['monkey', '-p', a.pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
    case 'stop':
      return shell(serial, ['am', 'force-stop', a.pkg]);
    case 'clear':
      return shell(serial, ['pm', 'clear', a.pkg]);
    case 'uninstall':
      return adb(['-s', serial, 'uninstall', a.pkg], { timeout: 60000 });
    case 'url':
      return shell(serial, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', a.url]);
    case 'notifications':
      return shell(serial, ['cmd', 'statusbar', 'expand-notifications']);
    case 'rotate': {
      const cur = (await shellRaw(serial, 'settings get system user_rotation')).trim();
      const next = String((Number(cur) || 0) % 2 === 0 ? 1 : 0);
      await shell(serial, ['settings', 'put', 'system', 'accelerometer_rotation', '0']);
      const r = await shell(serial, ['settings', 'put', 'system', 'user_rotation', next]);
      const d = hub.devices.get(serial);
      if (d) d.dims = null;
      return r;
    }
    case 'shell':
      return shellRaw(serial, a.cmd, { timeout: 120000 });
    case 'wait':
      return sleep(a.ms).then(() => '');
  }
}

// Aynı eylemi birden fazla cihaza paralel uygular.
export async function broadcast(hub, targets, a) {
  return Promise.all(
    targets.map(async (d) => {
      try {
        const out = await execute(hub, d.serial, a);
        return { serial: d.serial, ok: true, out: typeof out === 'string' ? out.slice(0, 65536) : '' };
      } catch (e) {
        return { serial: d.serial, ok: false, error: e.stderr || e.message };
      }
    })
  );
}
