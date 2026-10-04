// MobilMotor — yerel çoklu Android cihaz ve emülatör kontrol paneli.
// Güvenlik modeli: yalnızca 127.0.0.1, oturum anahtarı, Host/Origin/Sec-Fetch denetimi,
// sıkı CSP, kabuksuz komut çalıştırma, dış bağlantı yok, yerel işlem kaydı.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { ADB, adb, shell, shellRaw, run as calistir } from './lib/adb.js';
import { DeviceHub, SERIAL_RE } from './lib/devices.js';
import { validate, describe, broadcast, PKG_RE } from './lib/actions.js';
import * as emu from './lib/emulator.js';
import * as security from './lib/security.js';
import { Audit } from './lib/audit.js';
import { Macros, Jobs } from './lib/macros.js';
import { StreamHub } from './lib/stream.js';
import { Proxies } from './lib/proxies.js';
import * as sdkkur from './lib/sdkkur.js';
import * as hafif from './lib/hafif.js';
import * as oncelik from './lib/oncelik.js';
import * as sifirla from './lib/sifirla.js';
import { CihazKaydi } from './lib/kayit.js';
import * as playkur from './lib/playkur.js';
// Hesap şablonuna kaydetmeden önce kurulan uygulamalar (kopyalanan her emülatörde hazır gelir)
const SABLON_UYGULAMALARI = ['com.opera.browser'];
import { KEYS } from './lib/actions.js';
import { HttpError, safeName, stamp, clamp } from './lib/util.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const DIRS = Object.fromEntries(['macros', 'captures', 'logs', 'tmp'].map((d) => [d, path.join(DATA, d)]));
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
for (const f of fs.readdirSync(DIRS.tmp)) fs.rmSync(path.join(DIRS.tmp, f), { force: true });

const HOST = '127.0.0.1';
const PORT = Number(process.env.MOBILMOTOR_PORT) || 47800;
const SESSION_FILE = path.join(DATA, '.oturum');
const SCRCPY = path.join(ROOT, 'tools', 'scrcpy', 'scrcpy.exe');
// Oturum anahtarı: yeniden başlatmada açık paneller kopmasın diye diskte (yalnızca bu kullanıcı okur), 7 günde bir yenilenir
const KEY_FILE = path.join(DATA, '.anahtar');
const TOKEN = (() => {
  try {
    const k = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    if (/^[a-f0-9]{64}$/.test(k.token) && Date.now() - k.created < 7 * 864e5) return k.token;
  } catch {}
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(KEY_FILE, JSON.stringify({ token, created: Date.now() }), { mode: 0o600 });
  return token;
})();
const COOKIE = 'mobilmotor';

const hub = new DeviceHub();
// Panelden çıkarılan USB/ağ cihazları (yeniden başlatınca da çıkarılmış kalır)
const CIKARILAN_FILE = path.join(DATA, 'cikarilan.json');
try {
  for (const s of JSON.parse(fs.readFileSync(CIKARILAN_FILE, 'utf8'))) if (SERIAL_RE.test(s)) hub.hidden.add(s);
} catch {}
const cikarilanSave = () => fs.writeFileSync(CIKARILAN_FILE, JSON.stringify([...hub.hidden]));
const audit = new Audit(DIRS.logs);
const macros = new Macros(DIRS.macros);
const jobs = new Jobs(hub, audit);
const proxies = new Proxies(path.join(DATA, 'proxies.json'));
const emuProxy = new Map(); // AVD adı → kullanılan ağ çıkışının adı (arayüzde göstermek için)
const streams = new StreamHub(hub, path.join(ROOT, 'tools', 'scrcpy', 'scrcpy-server'));

// ---------- Otomatik uyku ----------
// Belirli süre kullanılmayan emülatör dondurulur (avd stop: içindeki Android'e hiç işlemci gitmez).
// Canlı görüntü, makro ya da logcat açıksa uyutulmaz; her eylemde kendiliğinden uyanır.
const lastActive = new Map();
const sleptAt = new Map();
const DERIN_MS = Number(process.env.MOBILMOTOR_DERIN_MS) || 10 * 60000; // uykudan 10 dk sonra derin uyku (test için kısaltılabilir)
// Derin uyku: durum kaydedilip emülatör kapatılır (işlemci %0, RAM boşalır); aynı ayarlarla geri açılır
const DERIN_FILE = path.join(DATA, 'derin-uyku.json');
const derinList = () => {
  try {
    return JSON.parse(fs.readFileSync(DERIN_FILE, 'utf8'));
  } catch {
    return {};
  }
};
const derinSave = (o) => fs.writeFileSync(DERIN_FILE, JSON.stringify(o));
const emuOpts = new Map(); // AVD adı → { headless, proxyId } (panelden nasıl açıldıysa)
async function deepSleep(d) {
  const name = d.avd || (await adb(['-s', d.serial, 'emu', 'avd', 'name'], { timeout: 5000 }).catch(() => '')).split(/\r?\n/)[0].trim();
  if (!name) return;
  let opts = emuOpts.get(name);
  if (!opts) {
    const wt = await adb(['-s', d.serial, 'emu', 'avd', 'windowtype'], { timeout: 5000 }).catch(() => '');
    opts = { headless: /headless/i.test(wt), proxyId: null };
  }
  // Durum kaydı çalışan sanal makineden alınır: önce kısa uyandır, sonra kaydedip kapat
  await adb(['-s', d.serial, 'emu', 'avd', 'start'], { timeout: 10000 }).catch(() => {});
  await adb(['-s', d.serial, 'emu', 'kill'], { timeout: 20000 });
  derinSave({ ...derinList(), [name]: { ...opts, at: new Date().toISOString() } });
  sleptAt.delete(d.serial);
  audit.log('sanal cihaz derin uykuya alındı (durum kaydedildi, işlemci %0)', [d.serial], name);
}
const awake = (serial) => lastActive.set(serial, Date.now());
async function wake(serials) {
  for (const s of serials) {
    awake(s);
    const d = hub.devices.get(s);
    if (d?.sleeping) {
      await adb(['-s', s, 'emu', 'avd', 'start'], { timeout: 10000 }).catch(() => {});
      d.sleeping = false;
      sleptAt.delete(s);
      hub.emit('change');
      audit.log('sanal cihaz uyandı', [s], hub.label(s));
    }
  }
}
function busy(serial) {
  const avd = hub.devices.get(serial)?.avd;
  if (avd && (ayarlar().uyanik || []).includes(avd)) return true; // "Uyutma" işaretli: arkada çalışmaya devam etsin
  const st = streams.sessions.get(serial);
  if (st && !st.closed && st.focusCount() > 0) return true; // küçük kart izlemek "kullanım" sayılmaz
  if (jobs.list().some((j) => j.state === 'running' && j.targets.includes(serial))) return true;
  return [...children].some((c) => c.serial === serial);
}
async function uykuKontrol() {
  const dk = ayarlar().uyku;
  for (const d of hub.devices.values()) {
    if (d.transport !== 'emulator' || d.state !== 'device') continue;
    if (!lastActive.has(d.serial)) awake(d.serial);
    if (d.sleeping == null) {
      // Durum bilinmiyor (ör. MobilMotor yeniden başladı): sor
      const st = await adb(['-s', d.serial, 'emu', 'avd', 'status'], { timeout: 5000 }).catch(() => '');
      d.sleeping = /stopped/.test(st);
      // Uyurken Android'e ulaşılamaz ama emülatör konsolu cevap verir: adını oradan al
      if (!d.avd) d.avd = (await adb(['-s', d.serial, 'emu', 'avd', 'name'], { timeout: 5000 }).catch(() => '')).split(/\r?\n/)[0].trim() || null;
      if (d.sleeping) hub.emit('change');
      continue;
    }
    if (busy(d.serial)) awake(d.serial);
    if (d.sleeping) {
      if (!sleptAt.has(d.serial)) sleptAt.set(d.serial, Date.now());
      if (dk && ayarlar().derin && Date.now() - sleptAt.get(d.serial) > DERIN_MS) await deepSleep(d).catch(() => {});
      continue;
    }
    if (!dk || Date.now() - lastActive.get(d.serial) < dk * 60000) continue;
    try {
      await adb(['-s', d.serial, 'emu', 'avd', 'stop'], { timeout: 10000 });
      d.sleeping = true;
      sleptAt.set(d.serial, Date.now());
      streams.sessions.get(d.serial)?.stop('uyku');
      hub.emit('change');
      audit.log('sanal cihaz uyutuldu', [d.serial], `${hub.label(d.serial)} — ${dk} dk kullanılmadı`);
    } catch {}
  }
}
setInterval(uykuKontrol, 15000).unref();

// ---------- Öncelik: odaktaki emülatör normal, diğerleri ve açılanlar düşük ----------
function oncelikKontrol() {
  for (const d of hub.devices.values()) {
    if (d.transport !== 'emulator') continue;
    oncelik.set(d.serial, d.state === 'device' && !d.sleeping && streams.focused(d.serial) && !acilanlar.has(d.serial)).catch(() => {});
  }
}
setInterval(oncelikKontrol, 4000).unref();
hub.on('change', () => {
  for (const serial of [...lastActive.keys()]) if (!hub.devices.has(serial)) oncelik.forget(serial);
  setTimeout(oncelikKontrol, 500);
});

// ---------- Canlı olaylar (SSE) ----------
const clients = new Set();
function publish(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
// Kullanıcının sürükle-bırakla verdiği sıra. Emülatörün seri numarası her açılışta değişebilir: AVD adıyla tutulur.
const SIRA_FILE = path.join(DATA, 'sira.json');
const SIRA_RE = /^(avd:)?[A-Za-z0-9._:\-]{1,64}$/;
const siraKey = (d) => (d.avd ? `avd:${d.avd}` : d.serial);
const siraList = () => {
  try {
    return JSON.parse(fs.readFileSync(SIRA_FILE, 'utf8'));
  } catch {
    return [];
  }
};
function sirali(list) {
  const idx = new Map(siraList().map((k, i) => [k, i]));
  const at = (d) => idx.get(siraKey(d)) ?? Infinity;
  return list.map((d) => ({ ...d, key: siraKey(d) })).sort((a, b) => at(a) - at(b)); // sırada olmayanlar sona, kendi aralarında eski sırayla
}
// Kendi penceresiyle açık emülatör: ekranı zaten o pencerede çiziliyor. Panel ayrıca video akıtırsa
// emülatörün içinde ikinci bir kodlama + tarayıcıda çözme = boşa işlemci. Kart video göstermez (istenirse gösterilir).
// Emülatör başına bir kez, yalnızca yeni emülatör görüldüğünde süreç listesine bakılır.
const pencereli = new Map(); // seri → true/false
let pencereBakiliyor = false;
async function pencereKontrol() {
  for (const s of [...pencereli.keys()]) if (!hub.devices.has(s)) pencereli.delete(s);
  const bak = [...hub.devices.values()].filter((d) => d.transport === 'emulator' && d.avd && !pencereli.has(d.serial));
  if (!bak.length || pencereBakiliyor) return;
  pencereBakiliyor = true;
  try {
    const out = await calistir('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name like 'qemu-system%'\" | ForEach-Object { $_.CommandLine }"], { timeout: 20000 });
    const satirlar = out.split(/\r?\n/);
    let degisti = false;
    for (const d of bak) {
      const satir = satirlar.find((l) => l.split(/\s+/).some((p, i, a) => a[i - 1] === '-avd' && p === d.avd));
      if (satir) {
        pencereli.set(d.serial, !/\s-no-window(\s|$)/.test(satir));
        degisti = true;
      }
    }
    if (degisti) publish('devices', devicesPayload());
  } catch {
  } finally {
    pencereBakiliyor = false;
  }
}
hub.on('change', () => setTimeout(pencereKontrol, 1000));
const devicesPayload = () => ({ devices: sirali(hub.list()).map((d) => ({ ...d, pencereli: pencereli.get(d.serial) === true })), hidden: hub.hiddenList(), adbError: hub.adbError });
hub.on('change', () => publish('devices', devicesPayload()));
audit.on('entry', (e) => publish('audit', e));
jobs.on('job', (j) => publish('job', j));
sdkkur.progress.on('p', (p) => publish('sdk', p));

// ---------- Yardımcılar ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

const BASE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=()',
  'Cache-Control': 'no-store',
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON bekleniyor');
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'İstek çok büyük');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Bozuk JSON');
  }
}

async function receiveFile(req, ext, limit = 4 * 1024 ** 3) {
  const tmp = path.join(DIRS.tmp, crypto.randomUUID() + ext);
  let size = 0;
  const counter = new Transform({
    transform(chunk, _e, cb) {
      size += chunk.length;
      cb(size > limit ? new HttpError(413, 'Dosya çok büyük') : null, chunk);
    },
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(tmp, { mode: 0o600 }));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e instanceof HttpError ? e : new HttpError(400, 'Yükleme yarıda kaldı');
  }
  if (size === 0) {
    await fsp.rm(tmp, { force: true });
    throw new HttpError(400, 'Boş dosya');
  }
  return tmp;
}

function openFolder(dir) {
  execFile('explorer.exe', [dir], { windowsHide: true }, () => {});
}

// Adresi varsayılan tarayıcıda açar (kabuk kullanmadan)
function openUrl(url) {
  execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
}

const cookieToken = (req) => {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  return m ? m[1] : '';
};
const tokenOk = (t) => t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));

// ---------- Yönlendirme ----------
const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/api/state', async () => ({
  ...devicesPayload(),
  jobs: jobs.list(),
  audit: audit.recent.slice(-150),
  profiles: emu.PROFILES,
  images: emu.systemImages().map((i) => i.id),
  scrcpy: fs.existsSync(SCRCPY),
}));

route('GET', '/api/d/:serial/screen', async ({ p, res }) => {
  if (hub.devices.get(p.serial)?.sleeping) throw new HttpError(409, 'Sanal cihaz uyuyor');
  const png = await hub.screen(p.serial);
  send(res, 200, png, 'image/png');
});

// Makro kaydı sırasında açık emülatörlerin kendi pencerelerinde yapılan dokunuşları da kaydet
let cihazKayitlari = null;
route('POST', '/api/kayit/basla', async () => {
  for (const k of cihazKayitlari || []) k.stop();
  cihazKayitlari = [];
  for (const d of hub.devices.values()) {
    if (d.transport !== 'emulator' || d.state !== 'device' || d.sleeping) continue;
    const k = new CihazKaydi(d.serial, (s) => publish('kayitAdim', { serial: d.serial, step: s }));
    await k.start().catch(() => {});
    cihazKayitlari.push(k);
  }
  return { ok: true, cihaz: cihazKayitlari.length };
});
route('POST', '/api/kayit/bitir', async () => {
  const steps = (cihazKayitlari || []).flatMap((k) => k.stop());
  cihazKayitlari = null;
  return { steps: steps.sort((a, b) => a.at - b.at) };
});

route('POST', '/api/sira', async ({ body }) => {
  const order = body.order;
  if (!Array.isArray(order) || order.length > 200 || !order.every((k) => typeof k === 'string' && SIRA_RE.test(k))) throw new HttpError(400, 'Geçersiz sıra');
  // Şu an bağlı olmayan cihazların yeri korunur: yeni sıranın arkasına eklenir
  const yeni = [...new Set(order)];
  for (const k of siraList()) if (!yeni.includes(k) && SIRA_RE.test(k)) yeni.push(k);
  fs.writeFileSync(SIRA_FILE, JSON.stringify(yeni.slice(0, 200)));
  publish('devices', devicesPayload());
  return { ok: true };
});

// Kabloyla/ağla bağlı cihazı panelden çıkar: listeden kalkar, canlı görüntü kapanır, hiçbir komut gitmez.
// Emülatörler çıkarılmaz (onlar "Kapat" ile kapatılır).
route('POST', '/api/cikar', async ({ body }) => {
  const serial = String(body.serial || '');
  if (!SERIAL_RE.test(serial) || serial.startsWith('emulator-')) throw new HttpError(400, 'Yalnızca USB/ağ cihazı çıkarılabilir');
  const d = hub.devices.get(serial);
  if (d?.transport === 'emulator') throw new HttpError(400, 'Yalnızca USB/ağ cihazı çıkarılabilir');
  for (const j of jobs.list()) if (j.state === 'running' && j.targets.includes(serial)) jobs.stop(j.id);
  streams.sessions.get(serial)?.stop('çıkarıldı');
  hub.hide(serial);
  cikarilanSave();
  audit.log('cihaz panelden çıkarıldı', [serial], hub.hiddenSeen.get(serial)?.model || '');
  return { ok: true };
});
route('POST', '/api/geri-ekle', async ({ body }) => {
  const serial = String(body.serial || '');
  if (!hub.hidden.has(serial)) throw new HttpError(404, 'Bu cihaz çıkarılmamış');
  hub.unhide(serial);
  cikarilanSave();
  audit.log('cihaz panele geri eklendi', [serial]);
  return { ok: true };
});

// Canlı video (scrcpy H.264). Tarayıcı WebCodecs ile donanımda çözer.
// mode=focus: odaktaki cihaz (tam kalite, uyuyorsa uyandırır); mode=thumb: küçük kart (uyuyanı uyandırmaz)
route('GET', '/api/d/:serial/stream', async ({ p, url, req, res }) => {
  hub.require(p.serial);
  const mode = ['thumb', 'big'].includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'focus';
  if (mode === 'thumb' && hub.devices.get(p.serial)?.sleeping) throw new HttpError(409, 'Sanal cihaz uyuyor');
  if (mode !== 'thumb') await wake([p.serial]);
  const s = streams.session(p.serial);
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'application/octet-stream' });
  res.socket?.setNoDelay(true);
  const remove = s.addViewer(res, mode);
  req.on('close', remove);
  return undefined;
});

// Tüm kartların canlı videosu TEK bağlantıda (çoklayıcı). Tarayıcı aynı adrese en fazla 6 bağlantı açar:
// her kart ayrı bağlantı kullanınca 6 cihazda dokunma/tuş komutları boş bağlantı bekleyip takılıyordu.
// Çerçeve: [1 bayt kanal][4 bayt uzunluk][veri]; uzunluk 0 = kanal bitti. Kanal 0 = çoklayıcı kimliği.
// Her kanalın verisi, eski tek-kart akışıyla bayt bayt aynıdır (tarayıcıdaki çözücü değişmez).
// Kimliği tarayıcı üretir ve ilk yanıtı beklemeden abone olur: bu makinedeki antivirüs, tarayıcıya giden
// akışı bir miktar veri birikene kadar tutabiliyor (küçük bir "hazır" mesajı hiç ulaşmıyordu).
const muxes = new Map();
const MUX_END = Buffer.alloc(0);
const MUX_ID_RE = /^[0-9a-f]{32}$/;
function muxGet(id) {
  if (typeof id !== 'string' || !MUX_ID_RE.test(id)) throw new HttpError(400, 'Geçersiz akış kimliği');
  let m = muxes.get(id);
  if (!m) {
    // Kapanmış ya da hiç bağlanmamış (30 sn) çoklayıcıları temizle
    for (const [k, o] of muxes) if (o.res ? o.res.destroyed : Date.now() - o.at > 30000) (muxes.delete(k), [...o.chans.keys()].forEach((ch) => muxUnsub(o, ch)));
    if (muxes.size >= 8) throw new HttpError(429, 'Çok fazla açık panel');
    m = { id, res: null, bekleyen: [], bekleyenBayt: 0, at: Date.now(), chans: new Map() };
    muxes.set(id, m);
  }
  if (m.res?.destroyed) throw new HttpError(410, 'Akış bağlantısı kapalı');
  return m;
}
function muxSend(m, ch, data) {
  const h = Buffer.allocUnsafe(5);
  h[0] = ch;
  h.writeUInt32BE(data.length, 1);
  if (!m.res) {
    // Bağlantı henüz gelmedi: kısa süre biriktir (sınırlı)
    if (m.bekleyenBayt > 8 * 1024 * 1024) return;
    m.bekleyen.push(h, data);
    m.bekleyenBayt += 5 + data.length;
    return;
  }
  if (m.res.destroyed) return;
  m.res.write(h);
  if (data.length) m.res.write(data);
}
function muxUnsub(m, ch) {
  const c = m.chans.get(ch);
  if (!c) return;
  m.chans.delete(ch);
  c.remove?.();
}
route('GET', '/api/mux', async ({ req, res, url }) => {
  const m = muxGet(url.searchParams.get('id'));
  if (m.res) throw new HttpError(409, 'Bu akış zaten açık');
  m.res = res;
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.flushHeaders(); // veri gelmeden de başlık gitsin
  res.socket?.setNoDelay(true);
  for (const b of m.bekleyen) res.write(b);
  m.bekleyen = [];
  m.bekleyenBayt = 0;
  req.on('close', () => {
    for (const ch of [...m.chans.keys()]) muxUnsub(m, ch);
    muxes.delete(m.id);
  });
  return undefined;
});
function muxOf(body) {
  const m = muxGet(body.id);
  const ch = Number(body.ch);
  if (!Number.isInteger(ch) || ch < 1 || ch > 255) throw new HttpError(400, 'Geçersiz kanal');
  return { m, ch };
}
route('POST', '/api/mux/sub', async ({ body }) => {
  const { m, ch } = muxOf(body);
  hub.require(body.serial);
  const mode = ['thumb', 'big'].includes(body.mode) ? body.mode : 'focus';
  if (mode === 'thumb' && hub.devices.get(body.serial)?.sleeping) return { uyuyor: true };
  if (mode !== 'thumb') await wake([body.serial]);
  muxUnsub(m, ch);
  const c = { serial: body.serial, remove: null };
  m.chans.set(ch, c);
  // İzleyici kodunun beklediği kadarı: write / writableLength / end
  const kanal = {
    write: (part) => c === m.chans.get(ch) && muxSend(m, ch, part),
    get writableLength() {
      return m.res ? m.res.writableLength : m.bekleyenBayt;
    },
    end: () => {
      if (c !== m.chans.get(ch)) return;
      m.chans.delete(ch);
      muxSend(m, ch, MUX_END);
    },
  };
  c.remove = streams.session(body.serial).addViewer(kanal, mode);
  return { ok: true };
});
route('POST', '/api/mux/unsub', async ({ body }) => {
  const { m, ch } = muxOf(body);
  muxUnsub(m, ch);
  return { ok: true };
});

// Anlık dokunma/tuş/kaydırma: adb shell yerine doğrudan scrcpy kontrol kanalı (milisaniyeler)
route('POST', '/api/d/:serial/control', async ({ p, body }) => {
  hub.require(p.serial);
  awake(p.serial);
  const s = streams.live(p.serial);
  if (!s) throw new HttpError(409, 'Canlı bağlantı yok');
  const unit = (v) => {
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0 || x > 1) throw new HttpError(400, 'Geçersiz koordinat');
    return x;
  };
  if (body.t === 'touch') {
    if (![0, 1, 2].includes(body.a)) throw new HttpError(400, 'Geçersiz dokunma');
    s.touch(body.a, unit(body.x), unit(body.y));
  } else if (body.t === 'key') {
    if (typeof body.key !== 'string' || !Object.hasOwn(KEYS, body.key)) throw new HttpError(400, 'Geçersiz tuş');
    s.key(KEYS[body.key]);
  } else if (body.t === 'keycode') {
    // Klavyeden gelen ham Android tuş kodu (+ Ctrl/Shift/Alt meta durumu)
    const code = Number(body.code);
    const meta = Number(body.meta || 0);
    if (!Number.isInteger(code) || code < 1 || code > 400) throw new HttpError(400, 'Geçersiz tuş kodu');
    if (!Number.isInteger(meta) || meta < 0 || meta > 0x7fffffff) throw new HttpError(400, 'Geçersiz tuş durumu');
    s.key(code, meta);
  } else if (body.t === 'text') {
    if (typeof body.text !== 'string' || !body.text.length || body.text.length > 300) throw new HttpError(400, 'Geçersiz metin');
    s.text(body.text);
  } else if (body.t === 'paste') {
    // İçerik kayda yazılmaz
    if (typeof body.text !== 'string' || !body.text.length || body.text.length > 100000) throw new HttpError(400, 'Geçersiz pano metni');
    s.paste(body.text);
  } else if (body.t === 'copy') {
    return { text: await s.copy(body.cut ? 2 : 1) };
  } else if (body.t === 'scroll') {
    const v = Number(body.v);
    if (!Number.isFinite(v)) throw new HttpError(400, 'Geçersiz kaydırma');
    s.scroll(unit(body.x), unit(body.y), Math.max(-16, Math.min(16, v)));
  } else if (body.t === 'reset') {
    s.requestKeyFrame();
  } else throw new HttpError(400, 'Bilinmeyen kontrol');
  return { ok: true };
});

route('POST', '/api/act', async ({ body }) => {
  const targets = hub.targets(body.targets);
  await wake(targets.map((d) => d.serial));
  const action = validate(body.action);
  const results = await broadcast(hub, targets, action);
  const quiet = ['tap', 'swipe', 'longpress', 'key', 'wait'].includes(action.type);
  if (!quiet || results.some((r) => !r.ok)) {
    audit.log(describe(action), results.map((r) => r.serial), results.filter((r) => !r.ok).map((r) => r.error).join(' | '), results.every((r) => r.ok));
  }
  return { results };
});

route('GET', '/api/d/:serial/apps', async ({ p, url }) => {
  hub.require(p.serial);
  await wake([p.serial]);
  const all = url.searchParams.get('all') === '1';
  const out = await shellRaw(p.serial, `pm list packages ${all ? '' : '-3'}`, { timeout: 20000 });
  const apps = out
    .split(/\r?\n/)
    .map((l) => l.replace(/^package:/, '').trim())
    .filter((x) => PKG_RE.test(x))
    .sort();
  return { apps };
});

route('POST', '/api/d/:serial/capture', async ({ p }) => {
  await wake([p.serial]);
  const png = await hub.screen(p.serial);
  const name = `${safeName(hub.label(p.serial), 40)}_${stamp()}.png`;
  await fsp.writeFile(path.join(DIRS.captures, name), png);
  audit.log('ekran görüntüsü kaydedildi', [p.serial], name);
  return { name };
});

route('POST', '/api/d/:serial/scrcpy', async ({ p }) => {
  await wake([p.serial]);
  hub.require(p.serial);
  if (!fs.existsSync(SCRCPY)) throw new HttpError(500, 'scrcpy bulunamadı (tools/scrcpy)');
  const title = `MobilMotor · ${hub.label(p.serial).replace(/[^\p{L}\p{N} ._-]/gu, '')} (${p.serial})`;
  const child = spawn(SCRCPY, ['-s', p.serial, '--no-clipboard-autosync', '--no-audio', '--window-title', title, '--stay-awake'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ADB }, // SDK'daki adb ile aynı sürüm: sunucu çakışması olmaz
  });
  child.on('error', () => {});
  child.unref();
  audit.log('scrcpy penceresi açıldı', [p.serial]);
  return { ok: true };
});

// Canlı logcat akışı (test için). Bağlantı kapanınca adb süreci de kapanır.
let logcatCount = 0;
const children = new Set(); // kapanışta temizlenecek logcat süreçleri
route('GET', '/api/d/:serial/logcat', async ({ p, url, req, res }) => {
  hub.require(p.serial);
  await wake([p.serial]);
  if (logcatCount >= 12) throw new HttpError(429, 'Çok fazla açık logcat');
  const level = url.searchParams.get('level') || 'V';
  if (!/^[VDIWEF]$/.test(level)) throw new HttpError(400, 'Geçersiz seviye');
  const pkg = url.searchParams.get('pkg') || '';
  const args = ['-s', p.serial, 'logcat', '-v', 'time', '-T', '300'];
  if (pkg) {
    if (!PKG_RE.test(pkg)) throw new HttpError(400, 'Geçersiz paket adı');
    const pid = (await shell(p.serial, ['pidof', pkg], { timeout: 8000 }).catch(() => '')).trim().split(/\s+/)[0];
    if (!/^\d+$/.test(pid)) throw new HttpError(409, `${pkg} şu an çalışmıyor — önce uygulamayı aç`);
    args.push(`--pid=${pid}`);
  }
  args.push(`*:${level}`);
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
  logcatCount++;
  const child = spawn(ADB, args, { windowsHide: true });
  child.serial = p.serial;
  children.add(child);
  let buf = '';
  let pending = [];
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    pending.push(...lines.filter(Boolean));
  });
  const flush = setInterval(() => {
    if (pending.length) {
      res.write(`event: lines\ndata: ${JSON.stringify(pending.slice(-2000))}\n\n`);
      pending = [];
    }
  }, 150);
  const end = () => {
    clearInterval(flush);
    child.kill();
  };
  child.on('exit', () => {
    res.write(`event: end\ndata: {}\n\n`);
    res.end();
  });
  req.on('close', end);
  child.on('close', () => {
    logcatCount--;
    children.delete(child);
  });
  return undefined;
});

route('POST', '/api/logcat/clear', async ({ body }) => {
  const targets = hub.targets(body.targets);
  await Promise.all(targets.map((d) => adb(['-s', d.serial, 'logcat', '-c'], { timeout: 10000 }).catch(() => '')));
  return { ok: true };
});

// Dosya yükleme: APK kur veya telefona dosya gönder (Download klasörüne)
route('POST', '/api/upload', async ({ url, req }) => {
  const kind = url.searchParams.get('kind');
  const targets = hub.targets((url.searchParams.get('targets') || '').split(',').filter(Boolean));
  await wake(targets.map((d) => d.serial));
  const original = safeName(decodeURIComponent(String(req.headers['x-filename'] || 'dosya')), 120);
  if (kind === 'apk') {
    if (!/\.apk$/i.test(original)) throw new HttpError(400, 'Yalnızca .apk dosyaları');
    const tmp = await receiveFile(req, '.apk');
    try {
      const head = Buffer.alloc(2);
      const fd = await fsp.open(tmp);
      await fd.read(head, 0, 2, 0);
      await fd.close();
      if (head.toString() !== 'PK') throw new HttpError(400, 'Bu dosya geçerli bir APK değil');
      const results = await Promise.all(
        targets.map(async (d) => {
          try {
            const out = await adb(['-s', d.serial, 'install', '-r', '-t', tmp], { timeout: 10 * 60 * 1000 });
            return { serial: d.serial, ok: /Success/.test(out), out: out.trim().slice(-500) };
          } catch (e) {
            return { serial: d.serial, ok: false, error: (e.stderr || e.stdout || e.message).toString().trim().slice(-500) };
          }
        })
      );
      audit.log(`APK kuruldu: ${original}`, targets.map((d) => d.serial), results.filter((r) => !r.ok).map((r) => r.error).join(' | '), results.every((r) => r.ok));
      return { results };
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }
  if (kind === 'file') {
    const tmp = await receiveFile(req, '.bin');
    try {
      const remote = `/sdcard/Download/${original}`;
      const results = await Promise.all(
        targets.map(async (d) => {
          try {
            await adb(['-s', d.serial, 'push', tmp, remote], { timeout: 10 * 60 * 1000 });
            return { serial: d.serial, ok: true, out: remote };
          } catch (e) {
            return { serial: d.serial, ok: false, error: (e.stderr || e.message).slice(-500) };
          }
        })
      );
      audit.log(`dosya gönderildi: ${original}`, targets.map((d) => d.serial), '', results.every((r) => r.ok));
      return { results };
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }
  throw new HttpError(400, 'Geçersiz yükleme türü');
});

// Makrolar
route('GET', '/api/macros', async () => ({ macros: await macros.list(), jobs: jobs.list() }));
route('POST', '/api/macros', async ({ body }) => {
  await macros.save(body.name, body.steps);
  audit.log('makro kaydedildi', [], `${body.name} (${body.steps.length} adım)`);
  return { ok: true };
});
route('DELETE', '/api/macros/:name', async ({ p }) => {
  await macros.remove(p.name);
  audit.log('makro silindi', [], p.name);
  return { ok: true };
});
route('POST', '/api/macros/run', async ({ body }) => {
  const targets = hub.targets(body.targets);
  await wake(targets.map((d) => d.serial));
  const m = await macros.load(body.name);
  const repeat = clamp(Math.round(Number(body.repeat) || 1), 1, 1000);
  audit.log('makro başladı', targets.map((d) => d.serial), `${m.name} × ${repeat}`);
  return jobs.start(m, targets, repeat);
});
route('POST', '/api/jobs/:id/stop', async ({ p }) => {
  jobs.stop(p.id);
  return { ok: true };
});

// Emülatörler
// proxy: yok | bir çıkış id'si | 'sirayla' (her emülatöre listeden sıradaki çıkış)
function pickProxy(choice, i) {
  if (!choice) return null;
  if (choice === 'sirayla') {
    const all = proxies.all();
    if (!all.length) throw new HttpError(400, 'Ağ çıkışı listesi boş');
    return all[i % all.length];
  }
  return proxies.get(String(choice));
}
const DIL_DEX = path.join(ROOT, 'tools', 'dil', 'mm-dil.dex');
// ---------- Sıralı açılış ----------
// Emülatörler aynı anda açılırsa işlemci boğulur: sırayla, biri açılıp oturunca sıradaki başlar.
const acilanlar = new Set(); // açılmakta olan seri numaraları (düşük öncelik)
const kuyruk = []; // { name, headless, proxy, resolve, reject }
let kuyrukCalisiyor = false;
function kuyrugaEkle(name, headless, proxy) {
  if (kuyruk.some((k) => k.name === name)) return Promise.resolve({ queued: true });
  return new Promise((resolve, reject) => {
    kuyruk.push({ name, headless, proxy, resolve, reject });
    publish('kuyruk', { sirada: kuyruk.map((k) => k.name) });
    kuyrukIsle();
  });
}
async function kuyrukIsle() {
  if (kuyrukCalisiyor) return;
  kuyrukCalisiyor = true;
  while (kuyruk.length) {
    const k = kuyruk[0];
    try {
      await startEmuNow(k.name, k.headless, k.proxy);
      k.resolve({ ok: true });
      // Açılış bitene (ve kısa süre oturana) kadar sıradakini başlatma
      const serial = await waitBoot((d) => d.avd === k.name, 180000);
      if (serial) {
        acilanlar.add(serial);
        await new Promise((r) => setTimeout(r, 15000));
        acilanlar.delete(serial);
      }
    } catch (e) {
      k.reject(e);
    }
    kuyruk.shift();
    publish('kuyruk', { sirada: kuyruk.map((x) => x.name) });
  }
  kuyrukCalisiyor = false;
}
// Dışarıdan çağrılan: ilk emülatör hemen başlar, diğerleri sıraya girer
function startEmu(name, headless, proxy) {
  const hemen = !kuyrukCalisiyor && !kuyruk.length;
  const p = kuyrugaEkle(name, headless, proxy);
  return hemen ? p : Promise.resolve({ queued: true });
}

// Bellek yetmeyecekse uyarır (açılışı engellemez; karar kullanıcının). Emülatör başına Android belleği
// + ~1 GB emülatör programı; Windows'a ~3 GB pay. Açık emülatörler belleğini zamanla doldurduğu için
// yalnızca boş belleğe değil, hepsi dolduğundaki toplama da bakılır.
const GB = 1024 ** 3;
function bellekUyar(name, ram) {
  const secim = ayarlar().bellek;
  const acik = [...hub.devices.values()].filter((d) => d.transport === 'emulator' && d.avd && d.avd !== name);
  const toplam = acik.reduce((t, d) => t + emu.ramFor(d.avd, secim) / 1024 + 1, 0) + ram / 1024 + 1 + 3;
  const bos = os.freemem() / GB;
  const makine = os.totalmem() / GB;
  if (bos >= ram / 1024 + 1 && toplam <= makine) return;
  const msg = `Bellek yetmiyor: ${name} açılıyor ama makine yavaşlayabilir (${acik.length + 1} emülatör ~${toplam.toFixed(0)} GB ister, bu bilgisayarda ${makine.toFixed(0)} GB var, şu an boş ${bos.toFixed(1)} GB). Bir emülatörü kapatmak ya da "Emülatör belleği"ni 3 GB yapmak rahatlatır.`;
  audit.log('bellek uyarısı', [], msg, false);
  publish('bellek', { msg });
}

async function startEmuNow(name, headless, proxy) {
  const ram = emu.ramFor(name, ayarlar().bellek);
  bellekUyar(name, ram);
  await emu.start(name, { headless, logDir: DIRS.logs, proxy, ram });
  emuOpts.set(name, { headless, proxyId: proxy?.id || null });
  const dl = derinList();
  if (dl[name]) {
    delete dl[name];
    derinSave(dl);
  }
  // İlk açılışta Türkçe (arka planda, açılış bitince)
  if (!emu.localeDone(name)) {
    waitBoot((d) => d.avd === name).then(async (serial) => {
      if (!serial) return;
      try {
        if (await emu.applyLocale(name, serial, DIL_DEX)) audit.log('sanal cihaz Türkçe yapıldı', [serial], name);
      } catch (e) {
        audit.log('Türkçe ayarlanamadı', [serial], e.message, false);
      }
    });
  }
  if (proxy) emuProxy.set(name, proxy.name);
  else emuProxy.delete(name);
  if (proxy) audit.log('ağ çıkışı atandı', [], `${name} → ${proxy.name}`);
}

route('GET', '/api/emu', async () => {
  const avds = await emu.listAvds();
  const running = {};
  for (const d of hub.devices.values()) if (d.avd) running[d.avd] = d.serial;
  return {
    avds: avds.filter((name) => name !== emu.TEMPLATE).map((name) => ({ name, serial: running[name] || null, proxy: running[name] ? emuProxy.get(name) || null : null, deep: !running[name] && !!derinList()[name] })),
    images: emu.systemImages().map((i) => i.id),
  };
});
route('POST', '/api/emu/create', async ({ body }) => {
  const count = clamp(Math.round(Number(body.count) || 1), 1, 10);
  const existing = new Set(await emu.listAvds());
  const created = [];
  const prefix = String(body.name || '');
  if (body.fromTemplate) {
    if (!accountInfo()) throw new HttpError(409, 'Önce Google hesabı şablonunu hazırla');
    if (templateSerial()) throw new HttpError(409, 'Hesap şablonu açıkken kopyalanamaz — önce "Kaydet" ile kapat');
  }
  for (let n = 1; created.length < count; n++) {
    const name = count === 1 && !existing.has(prefix) ? prefix : `${prefix}-${n}`;
    if (existing.has(name)) continue;
    created.push(body.fromTemplate ? await emu.cloneTemplate(name, body.profile) : await emu.create(name, body.profile, body.image));
    existing.add(name);
  }
  audit.log(body.fromTemplate ? 'sanal cihaz oluşturuldu (Google hesabıyla)' : 'sanal cihaz oluşturuldu', [], created.map((c) => c.name).join(', '));
  if (body.start) await Promise.all(created.map((c, i) => startEmu(c.name, !!body.headless, pickProxy(body.proxy, i))));
  return { created };
});
route('POST', '/api/emu/start', async ({ body }) => {
  const names = Array.isArray(body.names) ? body.names : [body.name];
  const dl = derinList();
  await Promise.all(
    names.map((n, i) => {
      const r = dl[n];
      if (r) return startEmu(n, !!r.headless, r.proxyId ? proxies.all().find((p) => p.id === r.proxyId) || null : null);
      return startEmu(n, !!body.headless, pickProxy(body.proxy, i));
    })
  );
  audit.log('sanal cihaz başlatıldı', [], names.join(', '));
  return { ok: true };
});
route('POST', '/api/emu/stop', async ({ body }) => {
  const serials = Array.isArray(body.serials) ? body.serials : [body.serial];
  for (const s of serials) await emu.stop(s);
  audit.log('sanal cihaz kapatıldı', serials);
  return { ok: true };
});
// ---------- Ayarlar + Hafif mod ----------
const AYAR_FILE = path.join(DATA, 'ayarlar.json');
function ayarlar() {
  try {
    return { hafif: true, uyku: 0, derin: false, uyanik: [], chromeKoru: true, bellek: 'otomatik', ...JSON.parse(fs.readFileSync(AYAR_FILE, 'utf8')), dusukRam: emu.DUSUK_RAM };
  } catch {
    return { hafif: true, uyku: 0, derin: false, uyanik: [], chromeKoru: true, bellek: 'otomatik', dusukRam: emu.DUSUK_RAM };
  }
}
// Her emülatöre her açılışta (boot_id) bir kez uygulanır
const hafifDone = new Map();
const hafifBusy = new Set();
function hafifKontrol() {
  for (const serial of [...hafifDone.keys()]) if (!hub.devices.has(serial)) hafifDone.delete(serial);
  if (!ayarlar().hafif) return;
  for (const d of hub.devices.values()) {
    if (d.transport !== 'emulator' || d.state !== 'device' || d.sleeping || hafifDone.has(d.serial) || hafifBusy.has(d.serial)) continue;
    hafifBusy.add(d.serial);
    (async () => {
      try {
        const [booted, bootId] = (await shellRaw(d.serial, 'getprop sys.boot_completed; cat /proc/sys/kernel/random/boot_id', { timeout: 5000 })).trim().split(/\s+/);
        if (booted !== '1') return; // açılış bitmedi; sonraki turda tekrar bakılır
        await hafif.apply(d.serial);
        hafifDone.set(d.serial, bootId);
        audit.log('hafif mod uygulandı', [d.serial], hub.label(d.serial));
      } catch {
      } finally {
        hafifBusy.delete(d.serial);
      }
    })();
  }
}
setInterval(hafifKontrol, 10000).unref();
hub.on('change', () => setTimeout(hafifKontrol, 3000));
hub.on('change', () => {
  for (const d of hub.devices.values()) {
    if (d.transport === 'emulator' && kuyrukCalisiyor && kuyruk[0] && (d.avd === kuyruk[0].name || !d.avd)) acilanlar.add(d.serial);
  }
});

// ---------- Chrome koruması ----------
// Emülatörde Chrome öndeyken kendiliğinden kapanırsa (çökme, bellek) yeniden açılır; Chrome sekmelerini
// kendisi geri yükler, sayfa kaldığı yerden devam eder. Kullanıcı Chrome'dan çıkıp başka yere geçtiyse
// (ana ekran, son uygulamalar) Chrome artık önde değildir: kapatılırsa açılmaz.
const CHROME = 'com.android.chrome';
const chromeOnde = new Map(); // seri → son bakışta Chrome öndeydi
const chromeAcilis = new Map(); // seri → son açılış zamanları (döngüye girmesin)
let chromeBakiliyor = false;
async function chromeKontrol() {
  if (chromeBakiliyor || ayarlar().chromeKoru === false) return;
  chromeBakiliyor = true;
  try {
    for (const s of [...chromeOnde.keys()]) if (!hub.devices.has(s)) chromeOnde.delete(s);
    const emus = [...hub.devices.values()].filter((d) => d.transport === 'emulator' && d.state === 'device' && !d.sleeping);
    await Promise.all(
      emus.map(async (d) => {
        const out = await shellRaw(d.serial, `pidof ${CHROME}; echo __MM__; dumpsys window | grep -m1 mFocusedApp`, { timeout: 8000 }).catch(() => null);
        if (out === null) return;
        const [pid, odak] = out.split('__MM__');
        const calisiyor = /\d/.test(pid);
        if (calisiyor) {
          chromeOnde.set(d.serial, odak.includes(CHROME));
          return;
        }
        if (!chromeOnde.get(d.serial)) return;
        chromeOnde.set(d.serial, false);
        const son = (chromeAcilis.get(d.serial) || []).filter((t) => Date.now() - t < 120000);
        if (son.length >= 3) {
          audit.log('Chrome sürekli kapanıyor: 2 dk içinde 3 kez açıldı, bu kez açılmadı', [d.serial], hub.label(d.serial));
          return;
        }
        chromeAcilis.set(d.serial, [...son, Date.now()]);
        await shell(d.serial, ['am', 'start', '-n', `${CHROME}/com.google.android.apps.chrome.Main`]).catch(() => {});
        audit.log('Chrome kendiliğinden kapanmıştı, yeniden açıldı (sekmeler geri yüklenir)', [d.serial], hub.label(d.serial));
      })
    );
  } finally {
    chromeBakiliyor = false;
  }
}
setInterval(chromeKontrol, 5000).unref();

route('GET', '/api/ayarlar', async () => ayarlar());
route('POST', '/api/ayarlar', async ({ body }) => {
  if (body.uyanik !== undefined) {
    const { name, on } = body.uyanik || {};
    if (typeof name !== 'string' || !emu.AVD_RE.test(name) || typeof on !== 'boolean') throw new HttpError(400, 'Geçersiz ayar');
    const list = new Set(ayarlar().uyanik || []);
    on ? list.add(name) : list.delete(name);
    fs.writeFileSync(AYAR_FILE, JSON.stringify({ ...ayarlar(), uyanik: [...list] }));
    audit.log(on ? 'uyutma kapalı (arkada çalışır)' : 'uyutma açık', [], name);
    if (on) {
      const d = [...hub.devices.values()].find((x) => x.avd === name);
      if (d?.sleeping) await wake([d.serial]);
    }
    return ayarlar();
  }
  if (body.chromeKoru !== undefined) {
    if (typeof body.chromeKoru !== 'boolean') throw new HttpError(400, 'Geçersiz ayar');
    fs.writeFileSync(AYAR_FILE, JSON.stringify({ ...ayarlar(), chromeKoru: body.chromeKoru }));
    audit.log(`Chrome koruması ${body.chromeKoru ? 'açıldı' : 'kapatıldı'}`, []);
    return ayarlar();
  }
  if (body.bellek !== undefined) {
    if (!['otomatik', 3072, 4096].includes(body.bellek)) throw new HttpError(400, 'Geçersiz bellek');
    fs.writeFileSync(AYAR_FILE, JSON.stringify({ ...ayarlar(), bellek: body.bellek }));
    audit.log(`emülatör belleği: ${body.bellek === 'otomatik' ? 'otomatik' : body.bellek / 1024 + ' GB'}`, []);
    return ayarlar();
  }
  if (body.derin !== undefined) {
    if (typeof body.derin !== 'boolean') throw new HttpError(400, 'Geçersiz ayar');
    fs.writeFileSync(AYAR_FILE, JSON.stringify({ ...ayarlar(), derin: body.derin }));
    audit.log(`derin uyku ${body.derin ? 'açıldı' : 'kapatıldı'}`, []);
    return ayarlar();
  }
  if (body.uyku !== undefined) {
    if (![0, 1, 3, 10, 30].includes(body.uyku)) throw new HttpError(400, 'Geçersiz uyku süresi');
    fs.writeFileSync(AYAR_FILE, JSON.stringify({ ...ayarlar(), uyku: body.uyku }));
    audit.log(body.uyku ? `otomatik uyku: ${body.uyku} dk` : 'otomatik uyku kapatıldı', []);
    if (!body.uyku) await wake([...hub.devices.values()].filter((d) => d.sleeping).map((d) => d.serial));
    return ayarlar();
  }
  if (typeof body.hafif !== 'boolean') throw new HttpError(400, 'Geçersiz ayar');
  fs.writeFileSync(AYAR_FILE, JSON.stringify({ ...ayarlar(), hafif: body.hafif }));
  const emus = [...hub.devices.values()].filter((d) => d.transport === 'emulator' && d.state === 'device');
  if (!body.hafif) {
    await Promise.all(emus.map((d) => hafif.revert(d.serial).catch(() => {})));
    hafifDone.clear();
  } else hafifKontrol();
  audit.log(`hafif mod ${body.hafif ? 'açıldı' : 'kapatıldı'}`, emus.map((d) => d.serial));
  return ayarlar();
});

// Emülatör bileşenleri: durum + (yalnızca kullanıcı isteyince) Google'dan doğrulanmış indirme
route('GET', '/api/sdk', async () => sdkkur.status());
route('POST', '/api/sdk/install', async () => {
  audit.log('emülatör bileşenleri indiriliyor (dl.google.com)', []);
  sdkkur.install().then(
    () => audit.log('emülatör bileşenleri kuruldu', []),
    (e) => audit.log('emülatör bileşenleri kurulamadı', [], e.message, false)
  );
  return { started: true };
});

// Ağ çıkışları (VPN sağlayıcısının HTTP proxy uçları)
route('GET', '/api/proxies', async () => ({ proxies: proxies.list() }));
route('POST', '/api/proxies', async ({ body }) => {
  const p = proxies.add(body);
  audit.log('ağ çıkışı eklendi', [], p.name);
  return p;
});
route('DELETE', '/api/proxies/:id', async ({ p }) => {
  proxies.remove(p.id);
  audit.log('ağ çıkışı silindi', []);
  return { ok: true };
});

// ---------- Google hesabı şablonu ----------
// Kullanıcı şablon emülatörde Play Store'a kendisi giriş yapar (şifre bu panelden geçmez).
// Kaydedince şablon kapanır; yeni emülatörler bu şablonun kopyası olarak hesap açık başlar.
const ACCOUNT_FILE = path.join(DATA, 'hesap.json');
function accountInfo() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
  } catch {
    return null;
  }
}
const templateSerial = () => [...hub.devices.values()].find((d) => d.avd === emu.TEMPLATE)?.serial || null;

async function waitBoot(pred, ms = 240000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const d = [...hub.devices.values()].find(pred);
    if (d && d.state === 'device') {
      const b = await shellRaw(d.serial, 'getprop sys.boot_completed', { timeout: 5000 }).catch(() => '');
      if (b.trim() === '1') return d.serial;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

route('GET', '/api/account', async () => {
  const info = accountInfo();
  const exists = (await emu.listAvds()).includes(emu.TEMPLATE);
  return { ready: !!info && exists, email: info?.email || null, savedAt: info?.savedAt || null, exists, serial: templateSerial() };
});

route('POST', '/api/account/open', async () => {
  let serial = templateSerial();
  if (!serial) {
    await emu.ensureTemplate();
    await startEmu(emu.TEMPLATE, false, null);
  }
  audit.log('hesap şablonu açıldı', []);
  // Açılış bitince Play Store'u öne getir (arka planda)
  waitBoot((d) => d.avd === emu.TEMPLATE).then((s) => {
    if (s) shell(s, ['monkey', '-p', 'com.android.vending', '-c', 'android.intent.category.LAUNCHER', '1']).catch(() => {});
  });
  return { ok: true };
});

route('POST', '/api/account/save', async () => {
  const serial = templateSerial();
  if (!serial) throw new HttpError(409, 'Hesap şablonu açık değil');
  const out = await shellRaw(serial, 'dumpsys account', { timeout: 15000 });
  const emails = [...new Set([...out.matchAll(/Account \{name=([^,}]+), type=com\.google\}/g)].map((m) => m[1]))];
  if (!emails.length) throw new HttpError(409, 'Henüz Google hesabı eklenmemiş. Play Store\'da giriş yapıp tekrar dene.');
  // Kaydetmeden önce şablona standart uygulamaları kur (kopyalanan her emülatörde hazır gelsin)
  const kurulan = [];
  for (const pkg of SABLON_UYGULAMALARI) {
    publish('sablon', { mesaj: `${pkg}: başlıyor` });
    try {
      const r = await playkur.install(serial, pkg, (m) => publish('sablon', { mesaj: `${pkg}: ${m}` }));
      kurulan.push(`${pkg} (${r})`);
    } catch (e) {
      throw new HttpError(409, `${pkg} kurulamadı: ${e.message}. Şablon penceresinde Play Store'dan elle kurup tekrar "Kaydet"e basabilirsin.`);
    }
  }
  publish('sablon', { mesaj: 'Uygulamalar hazır, şablon kaydediliyor' });
  await emu.stop(serial);
  await emu.waitGone(hub, serial);
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify({ email: emails[0], all: emails, savedAt: new Date().toISOString() }), { mode: 0o600 });
  audit.log('Google hesabı şablonu kaydedildi', [], `${emails[0]} — ${kurulan.join(', ')}`);
  return { email: emails[0], kurulan };
});

// Play Store'dan seçili cihazlara uygulama kur (hesap açık olmalı). Cihazlar sırayla işlenir.
route('POST', '/api/play-kur', async ({ body }) => {
  const targets = hub.targets(body.targets);
  if (typeof body.pkg !== 'string' || !PKG_RE.test(body.pkg)) throw new HttpError(400, 'Geçersiz paket adı');
  await wake(targets.map((d) => d.serial));
  audit.log(`Play Store'dan kurulum: ${body.pkg}`, targets.map((d) => d.serial));
  (async () => {
    for (const d of targets) {
      try {
        const r = await playkur.install(d.serial, body.pkg, (m) => publish('playkur', { serial: d.serial, pkg: body.pkg, mesaj: m }));
        publish('playkur', { serial: d.serial, pkg: body.pkg, mesaj: r, bitti: true });
      } catch (e) {
        publish('playkur', { serial: d.serial, pkg: body.pkg, mesaj: e.message, hata: true });
      }
    }
  })();
  return { started: true };
});

route('POST', '/api/emu/delete', async ({ body }) => {
  const running = [...hub.devices.values()].map((d) => d.avd).filter(Boolean);
  await emu.remove(body.name, running);
  audit.log('sanal cihaz silindi', [], body.name);
  return { ok: true };
});

// Güvenlik
route('GET', '/api/security', async () => ({ checks: await security.check(hub, PORT) }));
route('POST', '/api/security/fix', async ({ body }) => {
  await security.fix(hub, body.id, body.serial);
  audit.log(`güvenlik düzeltmesi: ${body.id}`, [body.serial]);
  return { ok: true };
});

// ---------- Motoru sıfırla (geri alınamaz; "SIFIRLA" yazılarak onaylanır) ----------
route('GET', '/api/sifirla', async () => sifirla.plan(DATA));
route('POST', '/api/sifirla', async ({ body }) => {
  if (body.onay !== 'SIFIRLA') throw new HttpError(400, 'Onay için SIFIRLA yazılmalı');
  for (const j of jobs.list()) if (j.state === 'running') jobs.stop(j.id);
  kuyruk.splice(0);
  const r = await sifirla.run({ dataDir: DATA, hub, streams, log: (m) => console.log('[sıfırla]', m) });
  for (const m of [emuOpts, emuProxy, hafifDone, lastActive, sleptAt, hub.hidden, hub.hiddenSeen]) m.clear();
  hub.poll();
  acilanlar.clear();
  audit.recent.splice(0);
  audit.log('MOTOR SIFIRLANDI: ilk kurulum haline getirildi', [], `silinen sanal cihazlar: ${r.silinen.join(', ') || 'yok'}`);
  publish('sifirlandi', {});
  return r;
});

route('POST', '/api/open-folder', async ({ body }) => {
  if (!['captures', 'macros', 'logs'].includes(body.which)) throw new HttpError(400, 'Geçersiz klasör');
  openFolder(DIRS[body.which]);
  return { ok: true };
});

route('GET', '/api/events', async ({ req, res }) => {
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
  res.write(`event: devices\ndata: ${JSON.stringify(devicesPayload())}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
  return undefined;
});

// ---------- Sunucu ----------
const server = http.createServer(async (req, res) => {
  try {
    // 1) DNS-rebinding koruması: yalnızca kendi adresimiz
    const host = req.headers.host;
    if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return send(res, 421, { error: 'Geçersiz host' });
    const url = new URL(req.url, `http://${host}`);
    const site = req.headers['sec-fetch-site'];

    // 2) Giriş: konsolun açtığı tek kullanımlık bağlantıdaki anahtar çereze çevrilir
    if (url.pathname === '/giris') {
      if (site && site !== 'none' && site !== 'same-origin') return send(res, 403, { error: 'Yasak' });
      const t = url.searchParams.get('t') || '';
      if (!tokenOk(t)) return send(res, 403, 'Geçersiz veya süresi dolmuş oturum. MobilMotor.exe ile yeniden başlat.', 'text/plain; charset=utf-8');
      return send(res, 303, '', 'text/plain', {
        'Set-Cookie': `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
        Location: '/',
      });
    }

    // 3) Oturum çerezi olmayan hiçbir şey göremez
    if (!tokenOk(cookieToken(req))) {
      return send(res, 401, 'Oturum yok. Paneli MobilMotor.exe ile aç.', 'text/plain; charset=utf-8');
    }

    // 4) Başka siteden gelen istekleri reddet (CSRF)
    if (site && site !== 'same-origin' && !(site === 'none' && req.method === 'GET' && url.pathname === '/')) {
      return send(res, 403, { error: 'Çapraz site isteği reddedildi' });
    }
    if (req.method !== 'GET') {
      if (req.headers.origin !== `http://${host}` || req.headers['x-mobilmotor'] !== '1') return send(res, 403, { error: 'Kaynak doğrulanamadı' });
    }

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, await fsp.readFile(path.join(ROOT, 'public', file)), type);
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const p = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      const body = req.method === 'POST' && url.pathname !== '/api/upload' ? await readJson(req) : {};
      const result = await r.handler({ req, res, url, p, body });
      if (result !== undefined && !res.headersSent) send(res, 200, result);
      return;
    }
    send(res, 404, { error: 'Bulunamadı' });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const msg = e instanceof HttpError ? e.message : e.stderr || e.message || 'Hata';
    if (status === 500) console.error('[hata]', req.method, req.url.split('?')[0], msg);
    if (!res.headersSent) send(res, status, { error: String(msg).slice(0, 1000) });
    else res.end();
  }
});
server.requestTimeout = 0; // büyük APK yüklemeleri ve canlı akışlar için
server.headersTimeout = 30000;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // Zaten çalışıyor: aynı oturumla tarayıcıyı aç
    try {
      const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      console.log('MobilMotor zaten çalışıyor.');
      if (!process.argv.includes('--no-open')) openUrl(`http://${HOST}:${s.port}/giris?t=${s.token}`);
    } catch {
      console.error(`${PORT} portu başka bir program tarafından kullanılıyor.`);
    }
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ port: PORT, token: TOKEN }), { mode: 0o600 });
  hub.start();
  streams.sweep();
  const link = `http://${HOST}:${PORT}/giris?t=${TOKEN}`;
  console.log('');
  console.log('  MOBİLMOTOR çalışıyor — yalnızca bu bilgisayardan erişilebilir.');
  console.log(`  Panel: http://${HOST}:${PORT}`);
  console.log(process.argv.includes('--launcher') ? '  Görev çubuğundaki simgeden kapatılır.' : '  Bu pencereyi kapatınca panel de kapanır.');
  console.log('');
  if (!process.argv.includes('--no-open')) openUrl(link);
  if (process.argv.includes('--print-link')) console.log(link);
});

const shutdown = () => {
  for (const c of children) c.kill();
  for (const k of cihazKayitlari || []) k.stop();
  streams.stopAll();
  try {
    fs.rmSync(SESSION_FILE, { force: true });
  } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
// MobilMotor.exe ile açıldıysa: exe kapanınca (veya çökerse) stdin kapanır, sunucu da kapanır
if (process.argv.includes('--launcher')) {
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.resume();
}
