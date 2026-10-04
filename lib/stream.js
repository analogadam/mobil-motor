// Canlı ekran: scrcpy-server (v4.1) ile cihazdan H.264 video + düşük gecikmeli dokunma kanalı.
// Bağlantı yalnızca adb forward (127.0.0.1) üzerinden; hiçbir şey ağa açılmaz.
// İki kalite: "focus" (odaktaki cihaz) ve "thumb" (diğer kartlar: küçük, düşük fps; donmuş görünmez, ucuzdur).
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { ADB, adb } from './adb.js';
import { sleep } from './util.js';

const VERSION = '4.1';
const REMOTE_JAR = `/data/local/tmp/mobilmotor-scrcpy-${VERSION}.jar`;
const IDLE_STOP_MS = 5000; // izleyen kalmayınca cihazdaki kodlayıcı hemen kapansın
const DOWNGRADE_MS = 3000; // odaktan çıkınca bu süre sonra küçük kaliteye in (hızlı geçişlerde yeniden başlatma olmasın)
const SLOW_CLIENT_BYTES = 3 * 1024 * 1024;

// Emülatörde kodlama işlemciyle yapılır: orada her kalite daha hafif
const QUALITY = {
  focus: { emu: { size: 720, fps: 15, rate: 1_200_000 }, dev: { size: 960, fps: 30, rate: 2_500_000 } },
  // Büyütülmüş ekran: içinde rahat iş yapılsın diye net
  big: { emu: { size: 1280, fps: 15, rate: 2_500_000 }, dev: { size: 1600, fps: 30, rate: 5_000_000 } },
  // Küçük kartlar: yalnızca "çalıştığı görünsün" — çok küçük ve seyrek; ekran değişmezse kodlayıcı boşta kalır
  thumb: { emu: { size: 360, fps: 2, rate: 150_000 }, dev: { size: 400, fps: 2, rate: 250_000 } },
};

const RANK = { thumb: 0, focus: 1, big: 2 };

// Tarayıcıya giden çerçeve: [tip u8][uzunluk u32][veri]
const T_SESSION = 1;
const T_CONFIG = 2;
const T_KEY = 3;
const T_DELTA = 4;
const frame = (type, payload) => {
  const h = Buffer.allocUnsafe(5);
  h[0] = type;
  h.writeUInt32BE(payload.length, 1);
  return [h, payload];
};

export class StreamHub {
  constructor(hub, jarPath) {
    this.hub = hub;
    this.jar = jarPath;
    this.sessions = new Map();
    hub.on('change', () => {
      for (const [serial, s] of this.sessions) {
        const d = hub.devices.get(serial);
        if (!d || d.state !== 'device') s.stop('cihaz ayrıldı');
      }
    });
  }

  session(serial) {
    let s = this.sessions.get(serial);
    if (!s || s.closed) {
      s = new Session(serial, this.jar, () => this.sessions.delete(serial));
      this.sessions.set(serial, s);
    }
    return s;
  }

  live(serial) {
    const s = this.sessions.get(serial);
    return s && !s.closed && s.size && s.control ? s : null;
  }

  // Odakta izlenen (tam kalite) cihaz var mı
  focused(serial) {
    const s = this.sessions.get(serial);
    return !!s && !s.closed && s.focusCount() > 0;
  }

  // Kapanışta tüneller beklenerek silinir (süreç çıkmadan önce bitsin)
  stopAll() {
    for (const s of this.sessions.values()) {
      const port = s.port;
      s.port = null;
      s.stop('kapanış');
      if (port) {
        try {
          execFileSync(ADB, ['-s', s.serial, 'forward', '--remove', `tcp:${port}`], { timeout: 3000, windowsHide: true, stdio: 'ignore' });
        } catch {}
      }
    }
  }

  // Açılışta: önceki (çökmüş/zorla kapatılmış) oturumlardan kalan scrcpy tünellerini süpür
  async sweep() {
    const list = await adb(['forward', '--list'], { timeout: 8000 }).catch(() => '');
    for (const line of list.split(/\r?\n/)) {
      const m = line.trim().match(/^(\S+)\s+(tcp:\d+)\s+localabstract:scrcpy_[0-9a-f]{8}$/);
      if (m) await adb(['-s', m[1], 'forward', '--remove', m[2]], { timeout: 5000 }).catch(() => {});
    }
  }
}

class Session {
  constructor(serial, jar, onClose) {
    this.serial = serial;
    this.jar = jar;
    this.onClose = onClose;
    this.viewers = new Set();
    this.size = null;
    this.closed = false;
    this.lastReset = 0;
    this.log = [];
    this.mode = null; // ilk izleyici belirler
    this.gen = 0; // her (yeniden) başlatmada artar; eski bağlantının olayları yenisini kapatmasın
  }

  // Odakta ya da büyütülmüş izleyen sayısı ("kullanımda" sayılır)
  focusCount() {
    let n = 0;
    for (const v of this.viewers) if (v.mode !== 'thumb') n++;
    return n;
  }

  async start() {
    const g = ++this.gen;
    const q = QUALITY[this.mode][this.serial.startsWith('emulator-') ? 'emu' : 'dev'];
    try {
      await adb(['-s', this.serial, 'push', this.jar, REMOTE_JAR], { timeout: 30000 });
      if (g !== this.gen || this.closed) return;
      const scid = crypto.randomInt(1, 0x7fffffff).toString(16).padStart(8, '0');
      const port = Number((await adb(['-s', this.serial, 'forward', 'tcp:0', `localabstract:scrcpy_${scid}`], { timeout: 10000 })).trim());
      if (!port) throw new Error('adb forward başarısız');
      this.port = port;
      const cmd = [
        `CLASSPATH=${REMOTE_JAR}`,
        'app_process / com.genymobile.scrcpy.Server',
        VERSION,
        `scid=${scid}`,
        'log_level=warn',
        'tunnel_forward=true',
        'audio=false',
        'control=true',
        `max_size=${q.size}`,
        `video_bit_rate=${q.rate}`,
        `max_fps=${q.fps}`,
        'video_codec=h264',
        'clipboard_autosync=false', // pano bilgisayara aktarılmaz
        // cleanup=false: kalite değişiminde eski sunucunun temizliği yeni sunucunun dosyasını silmesin
        'cleanup=false',
      ].join(' ');
      const proc = spawn(ADB, ['-s', this.serial, 'shell', cmd], { windowsHide: true });
      this.proc = proc;
      const keep = (d) => {
        this.log.push(...d.toString('utf8').split(/\r?\n/).filter(Boolean));
        this.log = this.log.slice(-10);
      };
      proc.stdout.on('data', keep);
      proc.stderr.on('data', keep);
      proc.on('exit', () => g === this.gen && this.stop('scrcpy sunucusu kapandı'));

      const { socket, rest } = await this.connectVideo(port, g);
      if (g !== this.gen || this.closed) return socket.destroy();
      this.video = socket;
      const control = await connect(port);
      if (g !== this.gen || this.closed) return control.destroy();
      this.control = control;
      control.on('data', (d) => this.deviceMessages(d)); // cihazdan gelen: pano içeriği vb.
      control.on('error', () => g === this.gen && this.stop('kontrol kanalı koptu'));
      control.on('close', () => g === this.gen && this.stop('kontrol kanalı kapandı'));
      this.parse(socket, rest, g);
    } catch (e) {
      if (g === this.gen) this.stop(`başlatılamadı: ${e.message}${this.log.length ? ' — ' + this.log.join(' | ') : ''}`);
    }
  }

  // Sunucu dinlemeye başlayana kadar dene; ilk bayt (dummy) gelince bağlantı hazırdır
  async connectVideo(port, g) {
    for (let i = 0; i < 60 && !this.closed && g === this.gen; i++) {
      const got = await new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1');
        const done = (v) => {
          s.removeAllListeners('data');
          resolve(v);
        };
        s.once('data', (d) => {
          s.pause(); // ayrıştırıcı bağlanana kadar veri kaybolmasın
          done({ socket: s, rest: d.subarray(1) });
        });
        s.once('error', () => done(null));
        s.once('close', () => done(null));
        s.setTimeout(3000, () => (s.destroy(), done(null)));
      });
      if (got) {
        got.socket.setTimeout(0);
        got.socket.setNoDelay(true);
        return got;
      }
      await sleep(200);
    }
    throw new Error('scrcpy sunucusuna bağlanılamadı');
  }

  parse(socket, first, g) {
    let buf = first.length ? Buffer.from(first) : Buffer.alloc(0);
    let meta = false;
    const onData = (chunk) => {
      if (g !== this.gen) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      if (!meta) {
        if (buf.length < 68) return; // 64 bayt cihaz adı + 4 bayt codec
        const codec = buf.readUInt32BE(64);
        if (codec !== 0x68323634) return this.stop('beklenmeyen codec');
        buf = buf.subarray(68);
        meta = true;
      }
      while (buf.length >= 12) {
        const hi = buf.readUInt32BE(0);
        if (hi & 0x80000000) {
          // oturum paketi: ekran boyutu (döndürmede / kalite değişiminde değişir)
          this.size = { w: buf.readUInt32BE(4), h: buf.readUInt32BE(8) };
          const p = Buffer.allocUnsafe(8);
          p.writeUInt32BE(this.size.w, 0);
          p.writeUInt32BE(this.size.h, 4);
          this.broadcast(T_SESSION, p);
          buf = buf.subarray(12);
          continue;
        }
        const size = buf.readUInt32BE(8);
        if (buf.length < 12 + size) break;
        const payload = Buffer.from(buf.subarray(12, 12 + size));
        buf = buf.subarray(12 + size);
        if (hi & 0x40000000) {
          this.config = payload;
          this.broadcast(T_CONFIG, payload);
        } else {
          this.broadcast(hi & 0x20000000 ? T_KEY : T_DELTA, payload);
        }
      }
    };
    socket.on('data', onData);
    socket.resume();
    socket.on('error', () => g === this.gen && this.stop('video kanalı koptu'));
    socket.on('close', () => g === this.gen && this.stop('video kanalı kapandı'));
  }

  broadcast(type, payload) {
    for (const v of this.viewers) {
      if (type === T_DELTA && v.needKey) {
        // Anahtar kare gecikirse (ör. cihaz yeni açılırken kaçtıysa) yeniden iste: ekran donmasın
        if (Date.now() - v.waitingSince > 1500) {
          v.waitingSince = Date.now();
          this.requestKeyFrame();
        }
        continue;
      }
      if (type === T_KEY) v.needKey = false;
      // Yavaş istemci: gecikme birikmesin diye bir sonraki anahtar kareye atla
      if (v.res.writableLength > SLOW_CLIENT_BYTES && type === T_DELTA) {
        v.needKey = true;
        v.waitingSince = Date.now();
        this.requestKeyFrame();
        continue;
      }
      for (const part of frame(type, payload)) v.res.write(part);
    }
  }

  addViewer(res, mode = 'focus') {
    clearTimeout(this.idleTimer);
    const v = { res, mode, needKey: true, waitingSince: Date.now() };
    this.viewers.add(v);
    if (!this.mode) {
      this.mode = this.want();
      this.start();
    } else if (!this.retune()) {
      // Kalite değişmediyse mevcut akışa katıl
      if (this.size) {
        const p = Buffer.allocUnsafe(8);
        p.writeUInt32BE(this.size.w, 0);
        p.writeUInt32BE(this.size.h, 4);
        for (const part of frame(T_SESSION, p)) res.write(part);
      }
      if (this.config) for (const part of frame(T_CONFIG, this.config)) res.write(part);
      this.requestKeyFrame(true);
    }
    return () => {
      this.viewers.delete(v);
      if (!this.viewers.size) this.idleTimer = setTimeout(() => this.stop('izleyen yok'), IDLE_STOP_MS);
      else this.retune();
    };
  }

  // İzleyicilerin istediği en yüksek kalite
  want() {
    let best = 'thumb';
    for (const v of this.viewers) if (RANK[v.mode] > RANK[best]) best = v.mode;
    return best;
  }

  // İzleyicilere göre kaliteyi ayarla. Yükseltme hemen, düşürme kısa gecikmeyle. Yeniden başladıysa true.
  retune() {
    const want = this.want();
    if (want === this.mode) {
      clearTimeout(this.downTimer);
      return false;
    }
    if (RANK[want] > RANK[this.mode]) {
      clearTimeout(this.downTimer);
      this.restart(want);
      return true;
    }
    clearTimeout(this.downTimer);
    this.downTimer = setTimeout(() => {
      const w = this.want();
      if (RANK[w] < RANK[this.mode]) this.restart(w);
    }, DOWNGRADE_MS);
    return false;
  }

  restart(mode) {
    if (this.closed) return;
    this.mode = mode;
    this.teardown();
    for (const v of this.viewers) {
      v.needKey = true;
      v.waitingSince = Date.now();
    }
    this.start();
  }

  teardown() {
    this.gen++; // eski bağlantının olayları artık dikkate alınmaz
    this.video?.destroy();
    this.control?.destroy();
    this.proc?.kill();
    if (this.port) adb(['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`], { timeout: 5000 }).catch(() => {});
    this.video = this.control = this.proc = this.port = null;
    this.config = null;
  }

  requestKeyFrame(force = false) {
    const now = Date.now();
    if (!this.control || (!force && now - this.lastReset < 1000)) return;
    this.lastReset = now;
    this.control.write(Buffer.from([17])); // TYPE_RESET_VIDEO: yeni oturum + anahtar kare
  }

  position(buf, off, x, y) {
    const { w, h } = this.size;
    buf.writeInt32BE(Math.round(x * (w - 1)), off);
    buf.writeInt32BE(Math.round(y * (h - 1)), off + 4);
    buf.writeUInt16BE(w, off + 8);
    buf.writeUInt16BE(h, off + 10);
  }

  // action: 0 bas, 1 bırak, 2 sürükle
  touch(action, x, y) {
    const b = Buffer.alloc(32);
    b[0] = 2; // TYPE_INJECT_TOUCH_EVENT
    b[1] = action;
    b.writeBigInt64BE(-2n, 2); // parmak
    this.position(b, 10, x, y);
    b.writeUInt16BE(action === 1 ? 0 : 0xffff, 22); // basınç
    this.control.write(b);
  }

  // action: 0 bas, 1 bırak, undefined: ikisi; meta: Android META_* (Ctrl, Shift…)
  key(keycode, meta = 0, action) {
    for (const a of action === undefined ? [0, 1] : [action]) {
      const b = Buffer.alloc(14);
      b[0] = 0; // TYPE_INJECT_KEYCODE
      b[1] = a;
      b.writeInt32BE(keycode, 2);
      b.writeInt32BE(meta, 10);
      this.control.write(b);
    }
  }

  // Doğrudan yazı (ASCII için en hızlısı)
  text(str) {
    const t = Buffer.from(str, 'utf8');
    const h = Buffer.alloc(5);
    h[0] = 1; // TYPE_INJECT_TEXT
    h.writeUInt32BE(t.length, 1);
    this.control.write(Buffer.concat([h, t]));
  }

  // Cihaz panosuna yaz ve yapıştır: Türkçe dahil her karakter gider
  paste(str) {
    const t = Buffer.from(str, 'utf8');
    const h = Buffer.alloc(14);
    h[0] = 9; // TYPE_SET_CLIPBOARD
    h.writeBigInt64BE(BigInt((this.clipSeq = (this.clipSeq || 0) + 1)), 1);
    h[9] = 1; // yapıştır
    h.writeUInt32BE(t.length, 10);
    this.control.write(Buffer.concat([h, t]));
  }

  // Cihazda kopyala/kes yapıp panoyu oku (copyKey: 1 kopyala, 2 kes)
  copy(copyKey = 1) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clipWaiters = (this.clipWaiters || []).filter((w) => w !== done);
        reject(new Error('Cihaz panosu okunamadı'));
      }, 3000);
      const done = (text) => (clearTimeout(timer), resolve(text));
      (this.clipWaiters = this.clipWaiters || []).push(done);
      this.control.write(Buffer.from([8, copyKey])); // TYPE_GET_CLIPBOARD
    });
  }

  // Cihaz mesajları: [0] pano (u32 uzunluk + metin), [1] pano onayı (u64), [2] UHID (u16 id, u16 uzunluk, veri)
  deviceMessages(chunk) {
    let buf = this.devBuf ? Buffer.concat([this.devBuf, chunk]) : chunk;
    for (;;) {
      if (!buf.length) break;
      const type = buf[0];
      let need;
      if (type === 0) need = buf.length >= 5 ? 5 + buf.readUInt32BE(1) : Infinity;
      else if (type === 1) need = 9;
      else if (type === 2) need = buf.length >= 5 ? 5 + buf.readUInt16BE(3) : Infinity;
      else {
        buf = Buffer.alloc(0); // bilinmeyen: akışı bozmamak için at
        break;
      }
      if (buf.length < need) break;
      if (type === 0) {
        const text = buf.subarray(5, need).toString('utf8');
        const w = (this.clipWaiters || []).shift();
        if (w) w(text);
      }
      buf = buf.subarray(need);
    }
    this.devBuf = buf.length ? Buffer.from(buf) : null;
  }

  scroll(x, y, v) {
    const b = Buffer.alloc(21);
    b[0] = 3; // TYPE_INJECT_SCROLL_EVENT
    this.position(b, 1, x, y);
    b.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round((v / 16) * 32767))), 15);
    this.control.write(b);
  }

  stop(reason) {
    if (this.closed) return;
    this.closed = true;
    this.reason = reason;
    if (!['izleyen yok', 'kapanış', 'uyku'].includes(reason)) console.log(`[akış] ${this.serial} kapandı: ${reason}${this.log.length ? ' — ' + this.log.slice(-3).join(' | ') : ''}`);
    clearTimeout(this.idleTimer);
    clearTimeout(this.downTimer);
    for (const v of this.viewers) v.res.end();
    this.viewers.clear();
    this.teardown();
    this.onClose();
  }
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.setNoDelay(true);
      resolve(s);
    });
    s.once('error', reject);
  });
}
