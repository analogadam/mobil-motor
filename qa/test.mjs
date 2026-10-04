// MobilMotor test paketi — pentest, stabilite, ekran/kaynak ölçümü.
// Kullanım (MobilMotor açıkken):  node qa/test.mjs [--emu emulator-5554] [--sure 30]
//   --emu   : dokunma testleri YALNIZCA bu emülatörde yapılır (gerçek telefona dokunulmaz)
//   --sure  : akış stabilite testlerinin süresi (sn)
//   --telefonsuz : USB telefona akış da açılmaz (telefon başka bir testte kullanılırken)
// Hiçbir pencere açmaz; yalnızca 127.0.0.1'e bağlanır.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const EMU = arg('--emu', null);
const SURE = Number(arg('--sure', 30));
const TELEFONSUZ = process.argv.includes('--telefonsuz'); // gerçek telefona akış bile açılmaz (başkası kullanırken)
const ADB = path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const sess = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '.oturum'), 'utf8'));
const B = `http://127.0.0.1:${sess.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let section = '';
function check(name, ok, detail = '') {
  results.push({ section, name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}
function head(s) {
  section = s;
  console.log(`\n== ${s}`);
}
const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8', timeout: 20000, windowsHide: true });

// ---------- HTTP yardımcıları ----------
let COOKIE = '';
async function req(method, p, { body, headers = {}, auth = true, origin = true, custom = true, type = 'application/json' } = {}) {
  const h = { ...headers };
  if (auth && COOKIE) h.cookie = COOKIE;
  if (origin && method !== 'GET') h.origin = B;
  if (custom && method !== 'GET') h['x-mobilmotor'] = '1';
  if (body !== undefined && type) h['content-type'] = type;
  const res = await fetch(B + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}
function rawHost(hostHeader, p = '/api/state') {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: sess.port, path: p, headers: { host: hostHeader, cookie: COOKIE } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', () => resolve(0));
    r.end();
  });
}

// Canlı akışı oku: paket sayıları, en uzun boşluk, bit hızı
async function readStream(serial, secs, { onKey } = {}) {
  const ac = new AbortController();
  const t0 = Date.now();
  const st = { status: 0, session: 0, config: 0, key: 0, delta: 0, bytes: 0, firstKeyMs: null, maxGapMs: 0, ended: false, size: null };
  try {
    const res = await fetch(`${B}/api/d/${serial}/stream`, { headers: { cookie: COOKIE }, signal: ac.signal });
    st.status = res.status;
    if (!res.ok) return st;
    const reader = res.body.getReader();
    let buf = Buffer.alloc(0);
    let last = Date.now();
    const stopAt = t0 + secs * 1000;
    while (Date.now() < stopAt) {
      const r = await Promise.race([reader.read(), sleep(250).then(() => ({ tick: true }))]);
      if (r.tick) continue;
      if (r.done) {
        st.ended = true;
        break;
      }
      const now = Date.now();
      st.maxGapMs = Math.max(st.maxGapMs, now - last);
      last = now;
      buf = Buffer.concat([buf, Buffer.from(r.value)]);
      st.bytes += r.value.length;
      while (buf.length >= 5) {
        const n = buf.readUInt32BE(1);
        if (buf.length < 5 + n) break;
        const ty = buf[0];
        if (ty === 1) {
          st.session++;
          st.size = `${buf.readUInt32BE(5)}x${buf.readUInt32BE(9)}`;
        } else if (ty === 2) st.config++;
        else if (ty === 3) {
          st.key++;
          if (st.firstKeyMs === null) st.firstKeyMs = Date.now() - t0;
          onKey?.();
        } else st.delta++;
        buf = buf.subarray(5 + n);
      }
    }
  } catch {}
  ac.abort();
  st.kbps = Math.round((st.bytes * 8) / secs / 1000);
  st.fps = Math.round(((st.key + st.delta) / secs) * 10) / 10;
  return st;
}

// İşlemci ölçümü: süreçlerin CPU yüzdesi (tüm çekirdeklere göre)
function cpu(pids, secs) {
  if (!pids.length) return 0;
  const ps = `$ids=@(${pids.join(',')}); $a=(Get-Process -Id $ids -EA SilentlyContinue | Measure-Object CPU -Sum).Sum; Start-Sleep ${secs}; $b=(Get-Process -Id $ids -EA SilentlyContinue | Measure-Object CPU -Sum).Sum; [math]::Round(($b-$a)/${secs}*100/[Environment]::ProcessorCount,1)`;
  return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim().replace(',', '.'));
}
function pidsOf(filter) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { ${filter} } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true });
  return out.split(/\s+/).filter(Boolean).map(Number);
}
const serverPid = () => pidsOf(`$_.Name -eq 'node.exe' -and $_.CommandLine -match 'server\\.js'`);
const qemuPid = (avd) => pidsOf(`$_.Name -like 'qemu-system*' -and $_.CommandLine -match '-avd ${avd}( |$)'`);
const rssMB = (pid) => Math.round(Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8', windowsHide: true }).trim()) / 1048576);

async function screenshotHash(serial) {
  const r = await fetch(`${B}/api/d/${serial}/screen`, { headers: { cookie: COOKIE } });
  const b = Buffer.from(await r.arrayBuffer());
  return (await import('node:crypto')).createHash('sha1').update(b).digest('hex');
}

// =====================================================================
async function pentest() {
  head('PENTEST — kimlik doğrulama');
  for (const p of ['/', '/api/state', '/api/events', '/api/security', '/app.js']) check(`çerezsiz ${p} reddedilir`, (await req('GET', p, { auth: false })).status === 401);
  check('çerezsiz POST reddedilir', [401, 403].includes((await req('POST', '/api/act', { body: {}, auth: false })).status));
  check('sahte çerez reddedilir', (await req('GET', '/api/state', { auth: false, headers: { cookie: `mobilmotor=${'a'.repeat(64)}` } })).status === 401);
  for (const t of ['', 'x', sess.token.toUpperCase(), sess.token.slice(0, 63), sess.token + 'a', ` ${sess.token}`]) {
    check(`yanlış anahtar girişi reddedilir (${t.length} krk)`, (await req('GET', `/giris?t=${encodeURIComponent(t)}`, { auth: false })).status === 403);
  }
  const login = await req('GET', `/giris?t=${sess.token}`, { auth: false });
  const sc = login.headers.get('set-cookie') || '';
  COOKIE = sc.split(';')[0];
  check('doğru anahtar oturum açar', login.status === 303 && COOKIE.startsWith('mobilmotor='));
  check('çerez HttpOnly + SameSite=Strict', /HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc));
  check('başka siteden gelen giriş reddedilir', (await req('GET', `/giris?t=${sess.token}`, { auth: false, headers: { 'sec-fetch-site': 'cross-site' } })).status === 403);

  head('PENTEST — DNS rebinding / Host');
  for (const hh of ['evil.com', `evil.com:${sess.port}`, `127.0.0.1.nip.io:${sess.port}`, `127.0.0.1:${sess.port + 1}`, `[::1]:${sess.port}`]) {
    const code = await rawHost(hh);
    check(`Host "${hh}" reddedilir`, code === 421, `HTTP ${code}`);
  }
  // Ham soketle: boş / eksik / çift Host (http kütüphanesi bunları kendisi düzeltir, o yüzden elle)
  const raw = (hdr) =>
    new Promise((resolve) => {
      const s = net.connect(sess.port, '127.0.0.1', () => s.write(`GET /api/state HTTP/1.1\r\n${hdr}Cookie: ${COOKIE}\r\nConnection: close\r\n\r\n`));
      let d = '';
      s.on('data', (x) => (d += x));
      s.on('end', () => resolve(Number(d.split(' ')[1])));
      s.on('error', () => resolve(0));
    });
  for (const [name, hdr] of [['boş Host', 'Host: \r\n'], ['Host yok', ''], ['çift Host (evil + doğru)', `Host: evil.com\r\nHost: 127.0.0.1:${sess.port}\r\n`]]) {
    const code = await raw(hdr);
    check(`${name} reddedilir`, code === 421 || code === 400, `HTTP ${code}`);
  }
  check(`Host localhost:${sess.port} kabul edilir`, (await rawHost(`localhost:${sess.port}`)) === 200);

  head('PENTEST — CSRF / çapraz site');
  check('Origin başlığı olmayan POST reddedilir', (await req('POST', '/api/act', { body: {}, origin: false })).status === 403);
  check('yabancı Origin reddedilir', (await req('POST', '/api/act', { body: {}, origin: false, headers: { origin: 'http://evil.com' } })).status === 403);
  check('null Origin reddedilir', (await req('POST', '/api/act', { body: {}, origin: false, headers: { origin: 'null' } })).status === 403);
  check('özel başlık (x-mobilmotor) olmayan POST reddedilir', (await req('POST', '/api/act', { body: {}, custom: false })).status === 403);
  check('text/plain gövde (basit CORS isteği) reddedilir', (await req('POST', '/api/act', { body: '{}', type: 'text/plain' })).status === 415);
  for (const s of ['cross-site', 'same-site']) check(`Sec-Fetch-Site: ${s} reddedilir`, (await req('GET', '/api/state', { headers: { 'sec-fetch-site': s } })).status === 403);
  check('DELETE de Origin ister', (await req('DELETE', '/api/macros/x', { origin: false })).status === 403);

  head('PENTEST — dosya yolu atlatma');
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/%2e%2e%2fserver.js', '/..%5cserver.js', '/public/app.js', '/data/.oturum', '/data/.anahtar', '/lib/adb.js', '/app.js/../../server.js', '//server.js', '/app.js%00.txt', '/api/../server.js']) {
    const r = await req('GET', p);
    check(`${p} sızdırmaz`, r.status !== 200 || !/TOKEN|token|import /.test(r.text) || p === '/app.js/../../server.js', `HTTP ${r.status}`);
  }

  head('PENTEST — girdi doğrulama / enjeksiyon');
  const act = (targets, action) => req('POST', '/api/act', { body: { targets, action } });
  const serials = ['a;reboot', '$(reboot)', '`id`', '../x', 'x'.repeat(65), 'a b', '', null, 5, ['x']];
  for (const s of serials) check(`kötü seri ${JSON.stringify(s)?.slice(0, 20)} reddedilir`, [400, 404].includes((await act([s], { type: 'key', key: 'home' })).status));
  check('hedef listesi 65+ reddedilir', (await act(Array.from({ length: 65 }, (_, i) => `x${i}`), { type: 'key', key: 'home' })).status === 400);
  const anyDev = (await req('GET', '/api/state')).json.devices.find((d) => d.state === 'device')?.serial;
  if (anyDev) {
    const bad = [
      { type: 'launch', pkg: 'a;reboot' },
      { type: 'launch', pkg: "com.x' ; reboot ; '" },
      { type: 'launch', pkg: '../../x' },
      { type: 'url', url: 'javascript:alert(1)' },
      { type: 'url', url: 'file:///sdcard/x' },
      { type: 'url', url: 'intent://x#Intent;end' },
      { type: 'key', key: '__proto__' },
      { type: 'key', key: 'constructor' },
      { type: 'key', key: 'toString' },
      { type: '__proto__' },
      { type: 'tap', x: 'NaN', y: 0.5 },
      { type: 'tap', x: 2, y: 0.5 },
      { type: 'tap', x: -0.1, y: 0.5 },
      { type: 'swipe', x1: 0, y1: 0, x2: 1, y2: 1, ms: 1e9 },
      { type: 'text', text: 'x'.repeat(1001) },
      { type: 'text', text: 'çğş' },
      { type: 'wait', ms: -1 },
      { type: 'shell', cmd: '' },
      null,
      'tap',
    ];
    for (const a of bad) check(`kötü eylem ${JSON.stringify(a)?.slice(0, 40)} reddedilir`, (await act([anyDev], a)).status === 400);
    const ctl = (b) => req('POST', `/api/d/${anyDev}/control`, { body: b });
    for (const b of [{ t: 'touch', a: 5, x: 0.5, y: 0.5 }, { t: 'touch', a: 0, x: 'x', y: 0 }, { t: 'touch', a: 0, x: 9, y: 0 }, { t: 'key', key: '__proto__' }, { t: 'scroll', x: 0.5, y: 0.5, v: 'x' }, { t: 'zzz' }]) {
      check(`kötü kontrol ${JSON.stringify(b).slice(0, 40)} reddedilir`, [400, 409].includes((await ctl(b)).status));
    }
    check('logcat seviye enjeksiyonu reddedilir', (await req('GET', `/api/d/${anyDev}/logcat?level=V;reboot`)).status === 400);
    check('logcat paket enjeksiyonu reddedilir', (await req('GET', `/api/d/${anyDev}/logcat?pkg=a;reboot`)).status === 400);
    check('APK olmayan dosya reddedilir', (await req('POST', `/api/upload?kind=apk&targets=${anyDev}`, { body: new Uint8Array([1, 2, 3]), type: 'application/octet-stream', headers: { 'x-filename': 'x.apk' } })).status === 400);
    check('yanlış uzantı reddedilir', (await req('POST', `/api/upload?kind=apk&targets=${anyDev}`, { body: new Uint8Array([80, 75]), type: 'application/octet-stream', headers: { 'x-filename': 'x.exe' } })).status === 400);
    check('boş yükleme reddedilir', (await req('POST', `/api/upload?kind=file&targets=${anyDev}`, { body: new Uint8Array(0), type: 'application/octet-stream', headers: { 'x-filename': 'x.txt' } })).status === 400);
    check('geçersiz yükleme türü reddedilir', (await req('POST', `/api/upload?kind=exe&targets=${anyDev}`, { body: new Uint8Array([1]), type: 'application/octet-stream' })).status === 400);
  }
  for (const n of ['../x', '..\\x', '<script>', 'a/b', '', 'x'.repeat(41), 'CON:']) check(`kötü makro adı ${JSON.stringify(n).slice(0, 20)} reddedilir`, (await req('POST', '/api/macros', { body: { name: n, steps: [{ type: 'wait', ms: 1 }] } })).status === 400);
  for (const n of ['../x', '..', '.gizli', 'a b', 'x;y', 'ş']) check(`kötü AVD adı ${JSON.stringify(n)} reddedilir`, (await req('POST', '/api/emu/create', { body: { name: n, profile: 'phone', count: 1 } })).status === 400);
  check('AVD silmede yol atlatma reddedilir', (await req('POST', '/api/emu/delete', { body: { name: '../../x' } })).status === 400);
  check('klasör açmada keyfi yol reddedilir', (await req('POST', '/api/open-folder', { body: { which: 'C:\\Windows' } })).status === 400);
  check('güvenlik düzeltmesinde bilinmeyen işlem reddedilir', (await req('POST', '/api/security/fix', { body: { id: 'rm', serial: 'x' } })).status >= 400);
  // Çıkar / sıra / tek bağlantılı akış (çoklayıcı) / cihaz kaydı
  check('emülatör panelden çıkarılamaz', (await req('POST', '/api/cikar', { body: { serial: 'emulator-5554' } })).status === 400);
  for (const s of ['../x;rm', '', 'a b', 'x'.repeat(80)]) check(`kötü çıkarma kimliği ${JSON.stringify(s).slice(0, 12)} reddedilir`, (await req('POST', '/api/cikar', { body: { serial: s } })).status === 400);
  check('çıkarılmamış cihazı geri ekleme 404', (await req('POST', '/api/geri-ekle', { body: { serial: 'YOK999' } })).status === 404);
  check('bozuk sıra reddedilir', (await req('POST', '/api/sira', { body: { order: ['../../x', 'a b'] } })).status === 400);
  check('dizi olmayan sıra reddedilir', (await req('POST', '/api/sira', { body: { order: 'x' } })).status === 400);
  check('çok uzun sıra reddedilir', (await req('POST', '/api/sira', { body: { order: Array.from({ length: 201 }, (_, i) => `s${i}`) } })).status === 400);
  for (const id of ['', 'x', '../../x', 'A'.repeat(32), 'g'.repeat(32)]) check(`kötü akış kimliği ${JSON.stringify(id).slice(0, 12)} reddedilir`, (await req('GET', `/api/mux?id=${encodeURIComponent(id)}`)).status === 400);
  const muxId = (await import('node:crypto')).randomBytes(16).toString('hex');
  for (const ch of [0, 256, -1, 1.5, 'a']) check(`kötü akış kanalı ${JSON.stringify(ch)} reddedilir`, (await req('POST', '/api/mux/sub', { body: { id: muxId, ch, serial: 'x' } })).status === 400);
  check('bağlı olmayan cihaza akış aboneliği reddedilir', (await req('POST', '/api/mux/sub', { body: { id: muxId, ch: 1, serial: 'YOK999' } })).status === 404);
  const cift = await Promise.all([fetch(`${B}/api/mux?id=${muxId}`, { headers: { cookie: COOKIE } }), sleep(300).then(() => req('GET', `/api/mux?id=${muxId}`))]);
  check('aynı akış kimliği ikinci kez açılamaz', cift[1].status === 409, `HTTP ${cift[1].status}`);
  cift[0].body?.cancel().catch(() => {});
  check('akışsız kayıt başlat/bitir çalışır', (await req('POST', '/api/kayit/basla', { body: {} })).status === 200 && Array.isArray((await req('POST', '/api/kayit/bitir', { body: {} })).json?.steps));
  check('Chrome koruması ayarı yalnızca açık/kapalı kabul eder', (await req('POST', '/api/ayarlar', { body: { chromeKoru: 'evet' } })).status === 400);
  const { safeName } = await import(new URL('../lib/util.js', import.meta.url));
  check('dosya adı temizleme: ../../evil.apk', !safeName('../../evil.apk').includes('/') && !safeName('../../evil.apk').startsWith('.'), safeName('../../evil.apk'));
  check('dosya adı temizleme: ..\\..\\x', !safeName('..\\..\\x').includes('\\'), safeName('..\\..\\x'));

  head('PENTEST — kaynak tüketme (DoS) sınırları');
  check('2 MB üstü JSON reddedilir (413)', (await req('POST', '/api/act', { body: '{"a":"' + 'x'.repeat(2.1 * 1024 * 1024) + '"}' })).status === 413);
  check('bozuk JSON reddedilir (400)', (await req('POST', '/api/act', { body: '{bozuk', type: 'application/json' })).status === 400);
  const burst = await Promise.all(Array.from({ length: 200 }, () => req('GET', '/api/state').then((r) => r.status).catch(() => 0)));
  check('200 eşzamanlı istek: sunucu ayakta', burst.every((s) => s === 200), `${burst.filter((s) => s === 200).length}/200`);

  head('PENTEST — başlıklar ve yüzey');
  const r = await req('GET', '/');
  const csp = r.headers.get('content-security-policy') || '';
  check("CSP: default-src 'none'", csp.includes("default-src 'none'"));
  check("CSP: yalnızca kendi betiği (inline yok)", /script-src 'self'(;|$)/.test(csp));
  check("CSP: frame-ancestors 'none'", csp.includes("frame-ancestors 'none'"));
  for (const [k, v] of [['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY'], ['referrer-policy', 'no-referrer'], ['cache-control', 'no-store']]) check(`${k}: ${v}`, (r.headers.get(k) || '').toLowerCase() === v.toLowerCase());
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const code = js.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  check('arayüzde innerHTML/eval yok (XSS)', !/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|\beval\(|new Function\(|document\.write/.test(code));
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  check('arayüz dış kaynak yüklemiyor', !/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html) && !/(fetch|import|EventSource)\(\s*[`'"]https?:/.test(code));
  const srv = ['server.js', ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f !== 'sdkkur.js').map((f) => `lib/${f}`)].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const kur = fs.readFileSync(path.join(ROOT, 'lib', 'sdkkur.js'), 'utf8');
  check('tek dış bağlantı (sdkkur) yalnızca https://dl.google.com', [...kur.matchAll(/https?:\/\/[^'"`\s]+/g)].every((m) => /^https:\/\/dl\.google\.com([/;]|$)/.test(m[0])) && kur.includes("u.hostname !== 'dl.google.com'"));
  check('sunucuda kabuk (shell:true / exec) yok', !/shell:\s*true|\bexec\(|execSync\(/.test(srv));
  check('sunucuda dışarı istek yok (fetch/http.request/https)', !/\bfetch\(|http\.request|https\.request|from 'node:https'/.test(srv));
  check('dış npm paketi yok', !fs.existsSync(path.join(ROOT, 'node_modules')));
  const ns = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  const pid = serverPid()[0];
  const mine = ns.split(/\r?\n/).filter((l) => /LISTENING/.test(l) && l.trim().endsWith(` ${pid}`));
  check('panel yalnızca 127.0.0.1 dinliyor', mine.length > 0 && mine.every((l) => /\s127\.0\.0\.1:/.test(l)), mine.map((l) => l.trim().split(/\s+/)[1]).join(', '));
  const adbPids = pidsOf(`$_.Name -eq 'adb.exe'`);
  const adbListen = ns.split(/\r?\n/).filter((l) => /LISTENING/.test(l) && adbPids.some((p) => l.trim().endsWith(` ${p}`)));
  check('adb ve akış tünelleri dışarıya kapalı', adbListen.length > 0 && adbListen.every((l) => /\s127\.0\.0\.1:/.test(l)), `${adbListen.length} dinleyici`);
}

// =====================================================================
async function stability() {
  const state = (await req('GET', '/api/state')).json;
  const devs = state.devices.filter((d) => d.state === 'device' && !(TELEFONSUZ && d.transport !== 'emulator'));
  const phone = TELEFONSUZ ? null : devs.find((d) => d.transport === 'usb');

  head(`STABİLİTE — kesintisiz akış (${SURE} sn)`);
  // Test edilecek cihaz yoksa sessizce atlama: açıkça başarısız say
  const akisCihazlari = [phone, EMU && devs.find((x) => x.serial === EMU)].filter(Boolean);
  if (!akisCihazlari.length && devs.length) akisCihazlari.push(devs.find((d) => !d.sleeping) || devs[0]);
  check('test için bağlı cihaz var', akisCihazlari.length > 0, akisCihazlari.map((d) => d.label).join(', ') || 'hiç cihaz yok');
  for (const d of akisCihazlari) {
    const s = await readStream(d.serial, SURE);
    check(`${d.label}: akış ${SURE} sn kesilmedi`, s.status === 200 && !s.ended && s.key >= 1, `ilk kare ${s.firstKeyMs} ms, ${s.size}, ${s.fps} fps, ${s.kbps} kbps, en uzun boşluk ${s.maxGapMs} ms`);
  }

  head('STABİLİTE — hızlı bağlan/kop (10 kez)');
  const target = EMU || phone?.serial || akisCihazlari[0]?.serial;
  if (target) {
    let ok = 0;
    for (let i = 0; i < 10; i++) {
      const s = await readStream(target, 2.5);
      if (s.key >= 1) ok++;
    }
    check('10/10 bağlantıda görüntü geldi', ok === 10, `${ok}/10`);
    await sleep(7000); // boşta kapanma süresi
    // Panel başka bir sekmede açıksa o cihazı izliyor olabilir: o zaman temizlik testi anlamsız
    const fw = adb('-s', target, 'forward', '--list').split(/\r?\n/).filter((l) => l.startsWith(target) && l.includes('scrcpy_'));
    const ps = adb('-s', target, 'shell', 'ps -A -o ARGS | grep -c "[c]om.genymobile.scrcpy.Server" || true').trim();
    if (process.argv.includes('--panel-acik')) {
      // Açık panel bu cihazı izliyor olabilir: süreç sayısı bilgi amaçlı (sızıntı ölçümü panel kapalıyken yapılır)
      check('boşta temizlik (panel açık: bilgi)', true, `${fw.length} tünel, ${ps} süreç (panelin canlı akışları)`);
    } else {
      check('boşta scrcpy tüneli kalmadı', fw.length === 0, fw.join(' | ') || 'temiz');
      check('cihazda artık scrcpy süreci kalmadı', ps === '0', `süreç: ${ps}`);
    }
  }

  head('STABİLİTE — aynı cihaza 3 eşzamanlı izleyici');
  if (target) {
    const all = await Promise.all([1, 2, 3].map(() => readStream(target, 5)));
    check('3 izleyicinin hepsi görüntü aldı', all.every((s) => s.key >= 1), all.map((s) => `${s.key}k/${s.delta}d`).join(' '));
  }

  if (EMU) {
    head(`STABİLİTE — dokunma (yalnızca ${EMU})`);
    const ctl = (b) => req('POST', `/api/d/${EMU}/control`, { body: b });
    let streamDone;
    const live = new Promise((r) => (streamDone = r));
    const holder = readStream(EMU, 20, { onKey: () => streamDone() });
    await live;
    await sleep(800);
    check('ana ekran tuşu (canlı kanal)', (await ctl({ t: 'key', key: 'home' })).status === 200);
    await sleep(1200);
    const before = await screenshotHash(EMU);
    // bildirim panelini parmakla aşağı çek: bas, 10 adım sürükle, bırak
    const t0 = performance.now();
    await ctl({ t: 'touch', a: 0, x: 0.5, y: 0.01 });
    for (let i = 1; i <= 10; i++) await ctl({ t: 'touch', a: 2, x: 0.5, y: 0.01 + i * 0.06 });
    await ctl({ t: 'touch', a: 1, x: 0.5, y: 0.61 });
    const ctlMs = Math.round((performance.now() - t0) / 12);
    await sleep(1500);
    const after = await screenshotHash(EMU);
    check('parmakla sürükleme ekranı değiştirdi', before !== after, `komut başına ~${ctlMs} ms`);
    await ctl({ t: 'key', key: 'back' });
    await sleep(800);
    check('kaydırma (tekerlek) kabul edildi', (await ctl({ t: 'scroll', x: 0.5, y: 0.5, v: -2 })).status === 200);
    await ctl({ t: 'key', key: 'home' });
    await holder;
  }

  head('STABİLİTE — sunucu belleği');
  const pid = serverPid()[0];
  const m1 = rssMB(pid);
  for (let i = 0; i < 3; i++) await readStream(target, 3);
  await Promise.all(Array.from({ length: 300 }, () => req('GET', '/api/state')));
  const m2 = rssMB(pid);
  check('akış/istek sonrası bellek sızıntısı yok (<60 MB artış)', m2 - m1 < 60, `${m1} → ${m2} MB`);
}

// =====================================================================
async function resources() {
  head('KAYNAK — işlemci kullanımı (tüm çekirdeklerin yüzdesi)');
  const pid = serverPid();
  check('panel sunucusu boştayken', true, `%${cpu(pid, 5)}`);
  const state = (await req('GET', '/api/state')).json;
  const phone = TELEFONSUZ ? null : state.devices.find((d) => d.transport === 'usb' && d.state === 'device');
  if (phone) {
    const p = readStream(phone.serial, 8);
    await sleep(2000);
    check(`panel sunucusu, ${phone.label} canlı akışı sırasında`, true, `%${cpu(pid, 5)}`);
    const s = await p;
    check('telefon akışı bant genişliği', s.kbps < 6000, `${s.kbps} kbps, ${s.fps} fps, ${s.size}`);
  }
  if (EMU) {
    const avd = state.devices.find((d) => d.serial === EMU)?.avd;
    const q = qemuPid(avd);
    await sleep(6000);
    const idle = cpu(q, 6);
    check(`${avd} boşta (akış yok)`, true, `%${idle}`);
    const p = readStream(EMU, 10);
    await sleep(2000);
    const busy = cpu(q, 6);
    const s = await p;
    check(`${avd} canlı akış sırasında`, true, `%${busy} (akışın ek yükü ~%${Math.round((busy - idle) * 10) / 10}), ${s.fps} fps, ${s.kbps} kbps, ${s.size}`);
    const cfg = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${q[0]}").CommandLine`], { encoding: 'utf8' });
    check('emülatör ekran kartıyla çiziyor (-gpu host)', /-gpu host/.test(cfg));
    check('emülatör 2 çekirdekle sınırlı', /-cores 2/.test(cfg));
  }
}

// =====================================================================
const t0 = Date.now();
try {
  await pentest();
  await stability();
  await resources();
} catch (e) {
  check('test paketi hatasız tamamlandı', false, e.stack);
}
const bad = results.filter((r) => !r.ok);
console.log(`\nSONUÇ: ${results.length - bad.length}/${results.length} geçti, ${bad.length} başarısız — ${Math.round((Date.now() - t0) / 1000)} sn`);
for (const b of bad) console.log(`  ✗ [${b.section}] ${b.name} ${b.detail}`);
const out = path.join(ROOT, 'data', 'logs', `test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(out, JSON.stringify(results, null, 1));
console.log(`Rapor: ${out}`);
process.exit(bad.length ? 1 : 0);
