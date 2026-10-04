import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { ADB, adb, shellRaw, screencap } from './adb.js';
import { HttpError } from './util.js';

const SEP = '__KMD__';
const INFO_CMD = [
  'getprop ro.product.manufacturer',
  'getprop ro.product.model',
  'getprop ro.build.version.release',
  'getprop ro.build.version.sdk',
  'wm size',
  'wm density',
  'getprop ro.build.characteristics',
  'dumpsys battery',
].join(`; echo ${SEP}; `);

export const SERIAL_RE = /^[A-Za-z0-9._:\-]{1,64}$/;

// adb'ye bağlı tüm cihazları (USB, emülatör, ağ) izler; takılan/çıkan cihazları anında yakalar.
export class DeviceHub extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map();
    this.adbError = null;
    // Panelden çıkarılan (USB/ağ) cihazlar: listede görünmez, hiçbir komut gitmez; takılı olup olmadığı bilgisi tutulur
    this.hidden = new Set();
    this.hiddenSeen = new Map();
  }

  hide(serial) {
    this.hidden.add(serial);
    const d = this.devices.get(serial);
    if (d) {
      this.devices.delete(serial);
      this.hiddenSeen.set(serial, { model: d.info ? `${d.info.brand} ${d.info.model}` : d.model, transport: d.transport });
    }
    this.emit('change');
  }

  unhide(serial) {
    this.hidden.delete(serial);
    this.hiddenSeen.delete(serial);
    this.emit('change');
    this.poll();
  }

  hiddenList() {
    return [...this.hidden].sort().map((serial) => ({ serial, model: this.hiddenSeen.get(serial)?.model || '', connected: this.hiddenSeen.has(serial) }));
  }

  // Sürekli adb başlatmak yerine adb'nin değişiklik bildirimini dinle (anlık yük yok); seyrek yedek kontrol
  start() {
    this.poll();
    this.track();
    this.timer = setInterval(() => this.poll(), 15000);
  }

  track() {
    const p = spawn(ADB, ['track-devices'], { windowsHide: true });
    this.tracker = p;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      // Biçim: 4 hane onaltılık uzunluk + cihaz listesi
      for (;;) {
        const n = parseInt(buf.slice(0, 4), 16);
        if (Number.isNaN(n) || buf.length < 4 + n) break;
        buf = buf.slice(4 + n);
        clearTimeout(this.trackTimer);
        this.trackTimer = setTimeout(() => this.poll(), 300);
      }
    });
    p.on('error', () => {});
    p.on('exit', () => {
      if (!this.stopped) setTimeout(() => this.track(), 3000);
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.tracker?.kill();
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    let changed = false;
    try {
      const out = await adb(['devices', '-l'], { timeout: 8000 });
      const seen = new Map();
      for (const line of out.split(/\r?\n/).slice(1)) {
        const m = line.trim().match(/^(\S+)\s+(device|unauthorized|offline|authorizing|no permissions|recovery|sideload|bootloader)(.*)$/);
        if (!m) continue;
        const kv = Object.fromEntries([...m[3].matchAll(/(\w+):(\S+)/g)].map((x) => [x[1], x[2]]));
        seen.set(m[1], { state: m[2], kv });
      }
      const attached = new Set(seen.keys());
      for (const [serial, { kv }] of seen) {
        if (!this.hidden.has(serial)) continue;
        if (!this.hiddenSeen.has(serial)) changed = true;
        this.hiddenSeen.set(serial, { model: this.hiddenSeen.get(serial)?.model || (kv.model || '').replace(/_/g, ' '), transport: serial.includes(':') ? 'network' : 'usb' });
        seen.delete(serial);
      }
      for (const serial of [...this.hiddenSeen.keys()]) {
        if (!attached.has(serial)) {
          this.hiddenSeen.delete(serial);
          changed = true;
        }
      }
      for (const [serial, { state, kv }] of seen) {
        let d = this.devices.get(serial);
        if (!d) {
          d = {
            serial,
            state,
            transport: serial.startsWith('emulator-') ? 'emulator' : serial.includes(':') ? 'network' : 'usb',
            model: (kv.model || '').replace(/_/g, ' '),
            info: null,
            infoAt: 0,
            dims: null,
            avd: null,
          };
          this.devices.set(serial, d);
          changed = true;
        }
        if (d.state !== state) {
          d.state = state;
          d.info = null;
          d.dims = null;
          changed = true;
        }
        if (state === 'device' && !d.loading && !d.sleeping && Date.now() - d.infoAt > (d.transport === 'emulator' ? 300000 : 60000)) this.loadInfo(d);
      }
      for (const serial of [...this.devices.keys()]) {
        if (!seen.has(serial)) {
          this.devices.delete(serial);
          changed = true;
        }
      }
      if (this.adbError) {
        this.adbError = null;
        changed = true;
      }
    } catch (e) {
      const msg = e.code === 'ENOENT' ? 'adb bulunamadı (Android SDK platform-tools)' : 'adb yanıt vermiyor';
      if (this.adbError !== msg) {
        this.adbError = msg;
        changed = true;
      }
    } finally {
      this.polling = false;
    }
    if (changed) this.emit('change');
  }

  async loadInfo(d) {
    d.loading = true;
    try {
      const parts = (await shellRaw(d.serial, INFO_CMD, { timeout: 12000 })).split(SEP).map((s) => s.trim());
      const size = parts[4].match(/Override size:\s*(\d+)x(\d+)/) || parts[4].match(/Physical size:\s*(\d+)x(\d+)/);
      const dens = parts[5].match(/Override density:\s*(\d+)/) || parts[5].match(/Physical density:\s*(\d+)/);
      const w = size ? +size[1] : 0;
      const h = size ? +size[2] : 0;
      if (!w || !h) throw new Error('ekran henüz hazır değil'); // emülatör açılıyor: sonra tekrar dene
      const density = dens ? +dens[1] : 160;
      const sw = (Math.min(w, h) * 160) / density;
      const level = parts[7].match(/level:\s*(\d+)/);
      d.info = {
        brand: parts[0],
        model: parts[1],
        android: parts[2],
        sdk: +parts[3] || 0,
        width: w,
        height: h,
        density,
        form: parts[6].includes('tablet') || sw >= 600 ? 'tablet' : 'phone',
        battery: level ? +level[1] : null,
        charging: /(AC|USB|Wireless) powered: true/.test(parts[7]),
      };
      if (d.transport === 'emulator' && !d.avd) {
        const name = await adb(['-s', d.serial, 'emu', 'avd', 'name'], { timeout: 5000 }).catch(() => '');
        d.avd = name.split(/\r?\n/)[0].trim() || null;
      }
      d.infoAt = Date.now();
      this.emit('change');
    } catch {
      d.infoAt = Date.now() - 50000; // 10 sn sonra tekrar dene (emülatör açılıyor olabilir)
    } finally {
      d.loading = false;
    }
  }

  // Sadece listede olan ve yetkilendirilmiş cihazlara komut gider.
  require(serial) {
    if (typeof serial !== 'string' || !SERIAL_RE.test(serial)) throw new HttpError(400, 'Geçersiz cihaz kimliği');
    const d = this.devices.get(serial);
    if (!d) throw new HttpError(404, `Cihaz bağlı değil: ${serial}`);
    if (d.state !== 'device') throw new HttpError(409, `Cihaz hazır değil (${d.state}): ${serial}`);
    return d;
  }

  targets(list) {
    if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, 'Hedef cihaz seçilmedi');
    if (list.length > 64) throw new HttpError(400, 'Çok fazla hedef');
    return [...new Set(list)].map((s) => this.require(s));
  }

  screen(serial) {
    const d = this.require(serial);
    if (!d.capture) {
      d.capture = screencap(serial)
        .then((buf) => {
          // PNG IHDR'den gerçek (döndürülmüş) ekran boyutunu al
          if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
            d.dims = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), at: Date.now() };
          }
          return buf;
        })
        .finally(() => {
          d.capture = null;
        });
    }
    return d.capture;
  }

  async dims(serial) {
    const d = this.require(serial);
    if (!d.dims || Date.now() - d.dims.at > 15000) await this.screen(serial);
    if (!d.dims) throw new HttpError(500, 'Ekran boyutu okunamadı');
    return d.dims;
  }

  label(serial) {
    const d = this.devices.get(serial);
    if (!d) return serial;
    return d.avd || (d.info ? `${d.info.brand} ${d.info.model}` : d.model || serial);
  }

  list() {
    return [...this.devices.values()]
      .map((d) => ({
        serial: d.serial,
        state: d.state,
        transport: d.transport,
        label: this.label(d.serial),
        avd: d.avd,
        sleeping: !!d.sleeping,
        info: d.info,
      }))
      .sort((a, b) => a.serial.localeCompare(b.serial));
  }
}
