// Makro kaydı için emülatörün KENDİ penceresinde yapılan dokunuş ve tuşları okur (getevent).
// Panelden gönderilen dokunuşlar Android'e enjeksiyonla girer, burada görünmez: aynı adım iki kez kaydedilmez.
// Adımlar panelin makro biçimindedir (0–1 arası koordinat), zamanı "at" (ms, Date.now) ile verilir.
import { spawn } from 'node:child_process';
import { ADB, shellRaw } from './adb.js';

const LINE_RE = /^\[\s*[\d.]+\]\s+(\/dev\/input\/event\d+):\s+(\S+)\s+(\S+)\s+(\S+)/;
const TUSLAR = { KEY_BACK: 'back', KEY_HOMEPAGE: 'home', KEY_APPSELECT: 'recents' };
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export class CihazKaydi {
  constructor(serial, onStep) {
    this.serial = serial;
    this.onStep = onStep;
    this.steps = [];
    this.aygit = new Map(); // /dev/input/eventN → dokunuş durumu
  }

  async start() {
    // Ekran yönü: ham dokunma koordinatı cihazın doğal yönünde gelir
    const out = await shellRaw(this.serial, 'dumpsys input | grep -m1 -E "displayId=0.*orientation="', { timeout: 8000 }).catch(() => '');
    this.yon = Number((out.match(/orientation=(\d)/) || [])[1] || 0);
    this.p = spawn(ADB, ['-s', this.serial, 'shell', 'getevent', '-lt'], { windowsHide: true });
    let buf = '';
    this.p.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) this.satir(l);
    });
    this.p.on('error', () => {});
  }

  stop() {
    try {
      this.p?.kill();
    } catch {}
    return this.steps;
  }

  ekle(a) {
    const s = { ...a, at: Date.now() };
    this.steps.push(s);
    this.onStep?.(s);
  }

  // Ham (0–32767) → ekrandaki 0–1 konum, yöne göre döndürülmüş
  nokta(x, y) {
    const nx = x / 32767;
    const ny = y / 32767;
    switch (this.yon) {
      case 1:
        return [ny, 1 - nx];
      case 2:
        return [1 - nx, 1 - ny];
      case 3:
        return [1 - ny, nx];
      default:
        return [nx, ny];
    }
  }

  satir(l) {
    const m = l.match(LINE_RE);
    if (!m) return;
    const [, dev, tip, kod, deger] = m;
    if (tip === 'EV_KEY') {
      if (TUSLAR[kod] && deger === 'DOWN') this.ekle({ type: 'key', key: TUSLAR[kod] });
      return;
    }
    let s = this.aygit.get(dev);
    if (!s) this.aygit.set(dev, (s = { basili: false, x: 0, y: 0, inis: false, kalkis: false }));
    if (tip === 'EV_ABS') {
      if (kod === 'ABS_MT_TRACKING_ID') {
        if (deger === 'ffffffff') s.kalkis = true;
        else if (!s.basili) s.inis = true;
      } else if (kod === 'ABS_MT_POSITION_X') s.x = parseInt(deger, 16);
      else if (kod === 'ABS_MT_POSITION_Y') s.y = parseInt(deger, 16);
      return;
    }
    if (tip === 'EV_SYN' && kod === 'SYN_REPORT') {
      if (s.inis) {
        s.inis = false;
        s.basili = true;
        s.x0 = s.x;
        s.y0 = s.y;
        s.t0 = Date.now();
      }
      if (s.kalkis) {
        s.kalkis = false;
        if (!s.basili) return;
        s.basili = false;
        this.hareket(s);
      }
    }
  }

  hareket(s) {
    const [x1, y1] = this.nokta(s.x0, s.y0);
    const [x2, y2] = this.nokta(s.x, s.y);
    const sure = Date.now() - s.t0;
    const r = (v) => Math.round(clamp01(v) * 10000) / 10000;
    if (Math.hypot(x2 - x1, y2 - y1) < 0.02) {
      if (sure >= 500) this.ekle({ type: 'longpress', x: r(x1), y: r(y1), ms: Math.min(10000, sure) });
      else this.ekle({ type: 'tap', x: r(x1), y: r(y1) });
    } else {
      this.ekle({ type: 'swipe', x1: r(x1), y1: r(y1), x2: r(x2), y2: r(y2), ms: Math.min(10000, Math.max(30, sure)) });
    }
  }
}
