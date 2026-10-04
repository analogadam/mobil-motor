// MobilMotor arayüzü. Tüm DOM textContent ile kurulur (innerHTML yok) — cihazdan gelen veri kod olarak çalışamaz.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(method, url, body, headers = {}) {
  const isBlob = body instanceof Blob;
  const res = await fetch(url, {
    method,
    headers: { 'x-mobilmotor': '1', ...(body !== undefined && !isBlob ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.blob();
  if (res.status === 401) {
    sessionLost();
    throw new Error('Oturum yenilendi');
  }
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

// Sunucu yeni anahtarla açıldıysa: ham hata yerine ne yapılacağını söyle
function sessionLost() {
  if ($('#lost')) return;
  document.body.append(
    h('div', { id: 'lost', class: 'lost' }, h('strong', null, 'Oturum yenilendi'), 'MobilMotor yeniden başlatıldı. Görev çubuğundaki MobilMotor simgesine çift tıkla ya da masaüstündeki kısayolu aç.')
  );
}

function toast(msg, err = false) {
  const t = h('div', { class: `toast${err ? ' err' : ''}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}
const fail = (e) => toast(e.message || String(e), true);

// ---------- Durum ----------
const S = {
  devices: [],
  focus: null,
  targets: new Set(),
  stream: 'normal',
  rec: null,
  jobs: new Map(),
  profiles: {},
  tab: 'kontrol',
};
const tiles = new Map();

const ready = () => S.devices.filter((d) => d.state === 'device');
const dev = (serial) => S.devices.find((d) => d.serial === serial);
function targetList() {
  const live = new Set(ready().map((d) => d.serial));
  const sel = [...S.targets].filter((s) => live.has(s));
  if (sel.length) return sel;
  return S.focus && live.has(S.focus) ? [S.focus] : [];
}
function needTargets() {
  const t = targetList();
  if (!t.length) throw new Error('Önce bir cihaz seç');
  return t;
}
const labelOf = (s) => dev(s)?.label || s;

// ---------- Cihazlar ----------
function onDevices() {
  const live = ready();
  if (!S.focus || !live.some((d) => d.serial === S.focus)) {
    S.focus = live[0]?.serial || null;
    setTimeout(refreshStreams);
  }
  for (const s of [...S.targets]) if (!dev(s)) S.targets.delete(s);
  $('#adbError').hidden = !S.adbError;
  $('#adbError').textContent = S.adbError ? `⚠ ${S.adbError}` : '';
  renderRail();
  renderStage();
  renderTargetLine();
  if (S.tab === 'uygulama') loadApps();
}

function kindText(d) {
  const form = d.info?.form === 'tablet' ? 'tablet' : 'telefon';
  return d.transport === 'emulator' ? `sanal ${form}` : form;
}

function renderRail() {
  const ul = $('#devlist');
  ul.replaceChildren();
  if (!S.devices.length) ul.append(h('li', { class: 'hint' }, 'Bağlı cihaz yok.'));
  for (const d of S.devices) {
    const ok = d.state === 'device';
    const meta = ok
      ? [d.sleeping ? '💤 uyuyor' : '', (S.uyanik || []).includes(d.avd) ? '☀ uyutulmaz' : '', kindText(d), d.info ? `Android ${d.info.android}` : '…', d.info?.battery != null ? `%${d.info.battery}${d.info.charging ? '⚡' : ''}` : '']
          .filter(Boolean)
          .join(' · ')
      : d.state === 'unauthorized'
        ? 'telefonda izin ver'
        : d.state;
    const chip = ok ? d.transport : 'bad';
    const chipText = { usb: 'USB', network: 'Wi-Fi', emulator: 'EMU', bad: d.state === 'unauthorized' ? 'İZİN' : 'KAPALI' }[chip];
    ul.append(
      h(
        'li',
        { class: `dev${S.focus === d.serial ? ' focus' : ''}`, onclick: () => ok && setFocus(d.serial), ...suruklenir(d.serial, 'y') },
        h('input', {
          type: 'checkbox',
          checked: S.targets.has(d.serial),
          disabled: !ok,
          title: 'Hedeflere ekle',
          onclick: (e) => e.stopPropagation(),
          onchange: (e) => {
            e.target.checked ? S.targets.add(d.serial) : S.targets.delete(d.serial);
            renderStage();
            renderTargetLine();
          },
        }),
        h('span', { class: 'name', title: d.serial }, d.label),
        h('span', { class: `chip ${chip}` }, chipText),
        h('span', { class: 'meta' }, meta),
        d.transport !== 'emulator'
          ? h('button', { class: 'link cikar', title: 'Panelden çıkar: listeden kalkar, panel bu cihaza hiçbir komut göndermez', onclick: (e) => (e.stopPropagation(), cikar(d.serial)) }, '⏏ çıkar')
          : null
      )
    );
  }
  const hid = S.hidden || [];
  $('#cikarilanBox').hidden = !hid.length;
  $('#cikarilanList').replaceChildren(
    ...hid.map((x) =>
      h(
        'li',
        null,
        h('span', { class: 'name', title: x.serial }, x.model || x.serial),
        h('small', null, x.connected ? 'takılı' : 'takılı değil'),
        h('button', { class: 'link', onclick: () => geriEkle(x.serial) }, 'geri ekle')
      )
    )
  );
}

async function cikar(serial) {
  const ad = labelOf(serial);
  try {
    await api('POST', '/api/cikar', { serial });
    toast(`${ad} panelden çıkarıldı. Kabloyu güvenle çekebilirsin.`);
  } catch (e) {
    fail(e);
  }
}

async function geriEkle(serial) {
  try {
    await api('POST', '/api/geri-ekle', { serial });
    toast('Cihaz panele geri eklendi');
  } catch (e) {
    fail(e);
  }
}

// ---------- Sürükle-bırak ile sıralama (raf ve tezgâh aynı sırayı kullanır) ----------
let suruklenen = null;
function isaretTemizle() {
  $$('.drop-once, .drop-sonra').forEach((e) => e.classList.remove('drop-once', 'drop-sonra'));
}
// eksen: 'y' (raf: üst/alt yarı) ya da 'x' (tezgâh: sol/sağ yarı)
function suruklenir(serial, eksen) {
  const once = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return eksen === 'y' ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
  };
  return {
    draggable: 'true',
    ondragstart: (e) => {
      suruklenen = serial;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', serial);
      e.currentTarget.classList.add('suruklen');
    },
    ondragend: (e) => {
      suruklenen = null;
      e.currentTarget.classList.remove('suruklen');
      isaretTemizle();
    },
    ondragover: (e) => {
      if (!suruklenen || suruklenen === serial) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const o = once(e);
      e.currentTarget.classList.toggle('drop-once', o);
      e.currentTarget.classList.toggle('drop-sonra', !o);
    },
    ondragleave: (e) => e.currentTarget.classList.remove('drop-once', 'drop-sonra'),
    ondrop: (e) => {
      e.preventDefault();
      const kim = suruklenen;
      const o = once(e);
      isaretTemizle();
      if (kim && kim !== serial) siraDegistir(kim, serial, o);
    },
  };
}
async function siraDegistir(kim, hedef, once) {
  const list = S.devices.filter((d) => d.serial !== kim);
  const i = list.findIndex((d) => d.serial === hedef);
  if (i < 0) return;
  list.splice(once ? i : i + 1, 0, dev(kim));
  S.devices = list;
  renderRail();
  renderStage();
  try {
    await api('POST', '/api/sira', { order: list.map((d) => d.key || d.serial) });
  } catch (e) {
    fail(e);
  }
}

// Seçili ekranı büyüt/küçült (aynı anda tek büyük ekran; başka karta geçince küçülür)
function toggleBig(serial) {
  S.big = S.big === serial ? null : serial;
  if (S.focus !== serial) S.focus = serial;
  renderRail();
  renderStage();
  renderTargetLine();
  fitAll();
  refreshStreams();
  if (S.big) tiles.get(serial)?.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function setFocus(serial) {
  if (S.big && S.big !== serial) S.big = null;
  S.focus = serial;
  setTimeout(refreshStreams);
  renderRail();
  renderStage();
  renderTargetLine();
  if (S.tab === 'uygulama') loadApps();
}

function renderUyanik() {
  const d = dev(S.focus);
  const row = $('#uyanikRow');
  row.hidden = !(d && d.transport === 'emulator' && d.avd);
  if (!row.hidden) $('#uyanikCb').checked = (S.uyanik || []).includes(d.avd);
}

function renderTargetLine() {
  renderUyanik();
  const t = targetList();
  const el = $('#targetLine');
  el.replaceChildren();
  if (!t.length) return el.append('Hedef yok — raftan cihaz seç.');
  if (S.targets.size) el.append('Hedef: ', h('b', null, `${t.length} cihaz`), ` (${t.map(labelOf).join(', ')})`);
  else el.append('Hedef: ', h('b', null, labelOf(t[0])), h('small', null, '  · birden çok için rafta işaretle'));
}

// ---------- Tezgâh ----------
function renderStage() {
  const stage = $('#stage');
  const live = new Set(ready().map((d) => d.serial));
  for (const [serial, t] of tiles) {
    if (!live.has(serial)) {
      t.alive = false;
      t.abort?.abort();
      if (t.url) URL.revokeObjectURL(t.url);
      t.el.remove();
      tiles.delete(serial);
    }
  }
  $$('.pending, .empty', stage).forEach((e) => e.remove());
  for (const d of ready()) if (!tiles.has(d.serial)) createTile(d);
  // Kartları rafın sırasına diz (yalnız sıra bozuksa taşınır; canlı görüntü kesilmez)
  const sira = ready().map((d) => tiles.get(d.serial).el);
  const simdiki = [...stage.children].filter((e) => sira.includes(e));
  if (sira.some((e, i) => simdiki[i] !== e)) for (const e of sira) stage.append(e);
  for (const [serial, t] of tiles) {
    const d = dev(serial);
    t.el.classList.toggle('focus', serial === S.focus);
    t.el.classList.toggle('tablet', d?.info?.form === 'tablet');
    t.el.classList.toggle('sleeping', !!d?.sleeping);
    t.el.classList.toggle('big', S.big === serial);
    t.bigBtn.textContent = S.big === serial ? '⤡ Küçült' : '⤢ Büyüt';
    t.tag.hidden = !S.targets.has(serial);
    const pn = pencerede(t);
    if (pn !== !t.pencereNot.hidden) {
      t.pencereNot.hidden = !pn;
      t.el.classList.toggle('pencereli', pn);
      if (pn) t.abort?.abort(); // akış açıksa kapat
      t.wake?.();
    }
    t.name.textContent = d.label;
    t.meta.textContent = `${serial} · ${kindText(d)}`;
    fitTile(t);
  }
  for (const d of S.devices.filter((d) => d.state !== 'device')) {
    stage.append(
      h(
        'div',
        { class: 'tile pending' },
        h('div', { class: 'bezel' }, h('div', { class: 'ph' }, d.state === 'unauthorized' ? 'Telefonun ekranında\n"USB hata ayıklamaya izin ver"\npenceresini onayla' : `Durum: ${d.state}\n(açılıyor olabilir)`)),
        h('div', { class: 'plate' }, h('b', null, d.label), d.serial)
      )
    );
  }
  if (!S.devices.length) {
    stage.append(
      h(
        'div',
        { class: 'empty' },
        h('strong', null, 'Tezgâh boş'),
        'Bir cihaz bağla ya da soldan sanal cihaz başlat.',
        h(
          'ol',
          null,
          h('li', null, 'Telefonda: Ayarlar › Telefon hakkında › Yazılım bilgisi › Yapım numarasına 7 kez dokun'),
          h('li', null, 'Geliştirici seçenekleri › USB hata ayıklama: aç'),
          h('li', null, 'USB ile bağla, telefondaki izin penceresini onayla')
        )
      )
    );
  }
}

function createTile(d) {
  const img = h('img', { alt: `${d.label} ekranı`, draggable: 'false', hidden: true });
  const canvas = h('canvas', { 'aria-label': `${d.label} canlı ekran` });
  const tag = h('span', { class: 'target-tag', hidden: true }, 'HEDEF');
  const gosterBtn = h('button', null, 'Burada göster');
  const pencereNot = h(
    'div',
    { class: 'pencere-not', hidden: true },
    h('strong', null, 'Kendi penceresinde açık'),
    h('small', null, 'İşlemciyi korumak için burada gösterilmiyor. Masaüstündeki emülatör penceresini kullan.'),
    gosterBtn
  );
  const bezel = h('div', { class: 'bezel' }, canvas, img, tag, pencereNot);
  const name = h('b');
  const meta = h('span');
  const bigBtn = h('button', { class: 'bigbtn', title: 'Bu ekranı büyüt / küçült' }, '⤢ Büyüt');
  // Sürükleme tutamağı yalnızca alttaki isim şeridi: ekrandaki sürükleme cihaza dokunma olarak gider
  const { draggable, ...birak } = suruklenir(d.serial, 'x');
  const plate = h('div', { class: 'plate', draggable, title: 'Sırayı değiştirmek için buradan sürükle' }, name, meta, bigBtn);
  const el = h('div', { class: 'tile', ...birak }, bezel, plate);
  bigBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBig(d.serial);
  });
  const t = { serial: d.serial, el, img, canvas, tag, bezel, name, meta, bigBtn, pencereNot, alive: true, url: null, down: null, mode: 'video', live: false };
  gosterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    t.panelde = true;
    renderStage();
    t.wake?.();
  });
  t.surface = () => (t.mode === 'video' ? t.canvas : t.img);
  tiles.set(d.serial, t);
  $('#stage').append(el);
  bindInput(t, canvas);
  bindInput(t, img);
  kartGozcu.observe(el);
  tileLoop(t);
}

// Ekranda görünmeyen (kaydırılmış) kartlar akış açmaz
const kartGozcu = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const t = [...tiles.values()].find((x) => x.el === e.target);
    if (!t) continue;
    t.visible = e.isIntersecting;
    if (t.live && t.streamMode !== desiredMode(t)) t.abort?.abort();
    t.wake?.();
  }
});

// ---------- Ekran akışı ----------
// Odaktaki cihaz: tam kalite video. Diğer kartlar: çok hafif video (2 fps, küçük) — arada değişir, donuk görünmez.
// "Akış: Yavaş" seçiliyse diğer kartlar hiç akmaz (en az kaynak). Uyuyan cihazın kartı uyandırılmaz.
// Kendi penceresiyle açık emülatör panelde gösterilmez (çift çizim işlemciyi yoruyordu); kullanıcı isterse gösterilir
const pencerede = (t) => !!dev(t.serial)?.pencereli && !t.panelde;
function desiredMode(t) {
  if (pencerede(t)) return null;
  if (document.hidden || S.stream === 'off' || t.noVideo || !('VideoDecoder' in window)) return null;
  if (t.serial === S.focus) return S.big === t.serial ? 'big' : 'focus';
  if (S.stream === 'slow' || dev(t.serial)?.sleeping || t.visible === false) return null;
  return 'thumb';
}
const wantsVideo = (t) => desiredMode(t) !== null;

// Odak/görünürlük değişince döngüleri uyandır; kalitesi değişmesi gerekenlerin akışını yenile
function refreshStreams() {
  for (const t of tiles.values()) {
    if (t.live && t.streamMode !== desiredMode(t)) t.abort?.abort();
    t.wake?.();
  }
}
document.addEventListener('visibilitychange', refreshStreams);

const nap = (t, ms) =>
  new Promise((r) => {
    const timer = setTimeout(r, ms);
    t.wake = () => (clearTimeout(timer), r());
  });

let akisSirasi = 0;
let akisSirasiSifir = 0;
async function tileLoop(t) {
  // Her yeni kart bir öncekinden ~0,8 sn sonra akışa başlar (cihazlarda aynı anda program başlamasın)
  if (Date.now() - akisSirasiSifir > 5000) {
    akisSirasi = 0;
    akisSirasiSifir = Date.now();
  }
  const bekle = akisSirasi++ * 800;
  if (bekle && t.serial !== S.focus) await nap(t, bekle);
  let fails = 0;
  let lastThumb = 0;
  while (t.alive) {
    const mode = desiredMode(t);
    if (mode) {
      t.streamMode = mode;
      const shown = await playVideo(t, mode).catch(() => false);
      t.live = false;
      t.streamMode = null;
      if (!t.alive) return;
      if (shown === 'uyuyor') {
        await nap(t, 30000);
        continue;
      }
      fails = shown ? 0 : fails + 1;
      if (fails >= 3) {
        t.noVideo = true;
        toast(`${labelOf(t.serial)}: canlı video açılamadı, ekran görüntüsü moduna geçildi`, true);
      }
      if (!shown) await nap(t, 1500);
      continue;
    }
    // Video yoksa: uyuyan/gizli/durdurulmuş/kendi penceresinde açık cihazda yenileme yok
    if (pencerede(t) || document.hidden || S.stream === 'off' || (t.serial !== S.focus && (S.stream === 'slow' || dev(t.serial)?.sleeping))) {
      await nap(t, 60000);
      continue;
    }
    // Küçük resim: odakta değilse seyrek; video açılamayan odaktaki cihazda sık
    const focused = t.serial === S.focus;
    const gap = focused ? { fast: 300, normal: 800, slow: 2000 }[S.stream] : { fast: 8000, normal: 20000, slow: 60000 }[S.stream];
    if (Date.now() - lastThumb >= gap || !lastThumb) {
      await pngFrame(t);
      lastThumb = Date.now();
    }
    await nap(t, Math.max(200, gap - (Date.now() - lastThumb)));
  }
}

function avcCodec(cfg) {
  for (let i = 0; i + 4 < cfg.length; i++) {
    if (cfg[i] === 0 && cfg[i + 1] === 0 && cfg[i + 2] === 1 && (cfg[i + 3] & 0x1f) === 7) {
      const hex = (b) => b.toString(16).padStart(2, '0');
      return `avc1.${hex(cfg[i + 4])}${hex(cfg[i + 5])}${hex(cfg[i + 6])}`;
    }
  }
  return null;
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---------- Çoklayıcı: tüm kartların videosu tek bağlantıda ----------
// Tarayıcı aynı adrese en fazla 6 bağlantı açar; kart başına bir akış bağlantısı 6 cihazda
// tüm bağlantıları doldurup dokunma/tuş komutlarını bekletiyordu.
const mux = { id: null, acilis: null, kanallar: new Map(), sonraki: 1 };
function muxKanal() {
  const kuyruk = [];
  let bekleyen = null;
  let bitti = false;
  const k = {
    push(v) {
      if (bitti) return;
      if (bekleyen) (bekleyen({ value: v, done: false }), (bekleyen = null));
      else kuyruk.push(v);
    },
    close() {
      bitti = true;
      if (bekleyen) (bekleyen({ value: undefined, done: true }), (bekleyen = null));
    },
    read: () => (kuyruk.length ? Promise.resolve({ value: kuyruk.shift(), done: false }) : bitti ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => (bekleyen = r))),
  };
  return k;
}
// Kimliği tarayıcı üretir; kartlar bağlantının ilk yanıtını beklemeden abone olur (antivirüs küçük
// yanıtları bir süre tutabiliyor, veri akmaya başlayınca bağlantı kendiliğinden açılır).
function muxAc() {
  if (mux.acilis) return mux.acilis;
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  mux.id = id;
  mux.acilis = Promise.resolve();
  (async () => {
    const res = await fetch(`/api/mux?id=${id}`);
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = buf.length ? concatBytes(buf, value) : value;
      let off = 0;
      while (buf.length - off >= 5) {
        const ch = buf[off];
        const n = ((buf[off + 1] << 24) | (buf[off + 2] << 16) | (buf[off + 3] << 8) | buf[off + 4]) >>> 0;
        if (buf.length - off - 5 < n) break;
        const data = buf.slice(off + 5, off + 5 + n);
        off += 5 + n;
        if (n === 0) {
          mux.kanallar.get(ch)?.close();
          mux.kanallar.delete(ch);
        } else mux.kanallar.get(ch)?.push(data);
      }
      buf = off < buf.length ? buf.slice(off) : new Uint8Array(0);
    }
  })()
    .catch(() => {})
    .finally(() => {
      // Bağlantı koptu: tüm kanallar biter, kartlar kendiliğinden yeni bağlantıya abone olur
      if (mux.id !== id) return;
      mux.id = null;
      mux.acilis = null;
      for (const k of mux.kanallar.values()) k.close();
      mux.kanallar.clear();
    });
  return mux.acilis;
}
// Kartın akışına abone ol: okuyucu, 'uyuyor' ya da false döner
async function muxAbone(serial, mode, signal) {
  await muxAc();
  const id = mux.id;
  let ch = mux.sonraki;
  while (mux.kanallar.has(ch)) ch = (ch % 255) + 1;
  mux.sonraki = (ch % 255) + 1;
  const k = muxKanal();
  mux.kanallar.set(ch, k); // abonelikten önce: ilk baytlar kaybolmasın
  const birak = () => {
    if (mux.kanallar.get(ch) !== k) return;
    mux.kanallar.delete(ch);
    k.close();
    if (mux.id === id) api('POST', '/api/mux/unsub', { id, ch }).catch(() => {});
  };
  signal.addEventListener('abort', birak, { once: true });
  try {
    const r = await api('POST', '/api/mux/sub', { id, ch, serial, mode });
    if (r?.uyuyor) return (birak(), 'uyuyor');
  } catch {
    birak();
    return false;
  }
  return k;
}

async function playVideo(t, mode = 'focus') {
  const abort = new AbortController();
  t.abort = abort;
  const reader = await muxAbone(t.serial, mode, abort.signal);
  if (reader === 'uyuyor') return 'uyuyor';
  if (!reader) return false;
  const ctx = t.canvas.getContext('2d', { alpha: false, desynchronized: true });
  let shown = false;
  let decoder = null;
  let codec = '';
  let config = null;
  let needKey = true;
  let ts = 0;
  let buf = new Uint8Array(0);

  const setup = () => {
    const c = avcCodec(config);
    if (!c) return;
    if (decoder && decoder.state === 'configured' && c === codec) return;
    if (decoder && decoder.state !== 'closed') decoder.close();
    codec = c;
    decoder = new VideoDecoder({
      output: (f) => {
        if (S.stream !== 'off' && !document.hidden) {
          if (t.canvas.width !== f.displayWidth || t.canvas.height !== f.displayHeight) {
            t.canvas.width = f.displayWidth;
            t.canvas.height = f.displayHeight;
            fitTile(t);
          }
          ctx.drawImage(f, 0, 0);
        }
        f.close();
        if (!shown) {
          shown = true;
          t.mode = 'video';
          t.live = true;
          t.canvas.hidden = false;
          t.img.hidden = true;
          t.el.classList.remove('stale');
          fitTile(t);
        }
      },
      error: () => {
        decoder = null;
        needKey = true;
        control(t, { t: 'reset' });
      },
    });
    decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
    needKey = true;
  };

  try {
    while (t.alive) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = buf.length ? concatBytes(buf, value) : value;
      let off = 0;
      while (buf.length - off >= 5) {
        const type = buf[off];
        const n = ((buf[off + 1] << 24) | (buf[off + 2] << 16) | (buf[off + 3] << 8) | buf[off + 4]) >>> 0;
        if (buf.length - off - 5 < n) break;
        const p = buf.subarray(off + 5, off + 5 + n);
        off += 5 + n;
        if (type === 2) {
          config = p.slice();
          setup();
        } else if ((type === 3 || type === 4) && decoder && decoder.state === 'configured') {
          if (type === 4 && needKey) continue;
          // Çözücü geride kaldıysa gecikme birikmesin: bir sonraki anahtar kareye atla
          if (type === 4 && decoder.decodeQueueSize > 8) {
            needKey = true;
            control(t, { t: 'reset' });
            continue;
          }
          const data = type === 3 && config ? concatBytes(config, p) : p.slice();
          try {
            decoder.decode(new EncodedVideoChunk({ type: type === 3 ? 'key' : 'delta', timestamp: (ts += 16666), data }));
            if (type === 3) needKey = false;
          } catch {
            needKey = true;
          }
        }
      }
      buf = off < buf.length ? buf.slice(off) : new Uint8Array(0);
    }
  } finally {
    abort.abort();
    if (decoder && decoder.state !== 'closed') decoder.close();
  }
  return shown;
}

// Tek ekran görüntüsü (küçük resimler ve yedek mod)
async function pngFrame(t) {
  try {
    const blob = await api('GET', `/api/d/${encodeURIComponent(t.serial)}/screen`);
    if (!t.alive) return;
    const url = URL.createObjectURL(blob);
    const old = t.url;
    t.img.src = url;
    t.url = url;
    await t.img.decode().catch(() => {});
    t.mode = 'png';
    t.canvas.hidden = true;
    t.img.hidden = false;
    fitTile(t);
    if (old) URL.revokeObjectURL(old);
    t.el.classList.remove('stale');
  } catch {
    t.el.classList.add('stale');
  }
}

// Ekranı cihazın gerçek oranıyla, tezgâha sığacak boyda gösterir (dokunma koordinatları birebir eşleşir).
function fitTile(t) {
  const el = t.surface();
  const nw = t.mode === 'video' ? t.canvas.width : t.img.naturalWidth;
  const nh = t.mode === 'video' ? t.canvas.height : t.img.naturalHeight;
  if (!nw || !nh || nw === 300) return; // 300: boş canvas varsayılanı
  // Tüm kartlar aynı boyutta; yalnızca "Büyüt" denen ekran tezgâh yüksekliğinde
  const boxH = S.big === t.serial ? Math.max(420, window.innerHeight - 150) : 360;
  const maxW = Math.max(160, $('#stage').clientWidth - 70);
  let H = boxH - 20;
  let W = (H * nw) / nh;
  if (W > maxW) {
    W = maxW;
    H = (W * nh) / nw;
  }
  el.style.width = `${Math.round(W)}px`;
  el.style.height = `${Math.round(H)}px`;
}
const fitAll = () => tiles.forEach(fitTile);
addEventListener('resize', fitAll);

function norm(e, el) {
  const r = el.getBoundingClientRect();
  return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
}

function showTouch(t, p) {
  const r = t.surface().getBoundingClientRect();
  const b = t.bezel.getBoundingClientRect();
  const dot = h('span', { class: 'touch' });
  dot.style.left = `${r.left - b.left + p.x * r.width}px`;
  dot.style.top = `${r.top - b.top + p.y * r.height}px`;
  t.bezel.append(dot);
  setTimeout(() => dot.remove(), 500);
}

// Kontrol mesajları sırayla gider; bekleyen sürükleme hareketleri birleştirilir (akıcı ve düzenli).
function control(t, msg) {
  if (msg.t === 'touch' && msg.a === 2) {
    if (t.pendingMove) {
      t.pendingMove.x = msg.x;
      t.pendingMove.y = msg.y;
      return;
    }
    t.pendingMove = msg;
  }
  t.ctlChain = (t.ctlChain || Promise.resolve())
    .then(() => {
      if (msg === t.pendingMove) t.pendingMove = null;
      return fetch(`/api/d/${encodeURIComponent(t.serial)}/control`, {
        method: 'POST',
        headers: { 'x-mobilmotor': '1', 'content-type': 'application/json' },
        body: JSON.stringify(msg),
      });
    })
    .catch(() => {});
}

// ---------- Klavye ve pano (odaktaki canlı cihaz) ----------
const AKEY = {
  Backspace: 67, Delete: 112, Enter: 66, NumpadEnter: 66, Tab: 61, Escape: 111,
  ArrowLeft: 21, ArrowRight: 22, ArrowUp: 19, ArrowDown: 20, Home: 122, End: 123, PageUp: 92, PageDown: 93, Insert: 124,
};
const META = { ctrl: 0x1000 | 0x2000, shift: 0x1 | 0x40, alt: 0x2 | 0x10 };
function androidKeyFromLetter(k) {
  const c = k.toLowerCase();
  if (c >= 'a' && c <= 'z') return 29 + c.charCodeAt(0) - 97;
  if (c >= '0' && c <= '9') return 7 + c.charCodeAt(0) - 48;
  return null;
}
function metaOf(e) {
  return (e.ctrlKey || e.metaKey ? META.ctrl : 0) | (e.shiftKey ? META.shift : 0) | (e.altKey ? META.alt : 0);
}

function bindKeyboard(t, el) {
  el.tabIndex = 0;
  el.addEventListener('focus', () => t.el.classList.add('kbd'));
  el.addEventListener('blur', () => t.el.classList.remove('kbd'));
  el.addEventListener('keydown', async (e) => {
    if (!t.live || t.serial !== S.focus) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && (k === 'c' || k === 'x')) {
      e.preventDefault();
      try {
        const res = await api('POST', `/api/d/${encodeURIComponent(t.serial)}/control`, { t: 'copy', cut: k === 'x' });
        if (res.text) {
          await navigator.clipboard.writeText(res.text);
          toast(`Panoya ${k === 'x' ? 'kesildi' : 'kopyalandı'} (${res.text.length} karakter)`);
        } else toast('Cihazda seçili metin yok');
      } catch (err) {
        fail(err);
      }
      return;
    }
    if (ctrl && k === 'v') return; // "paste" olayı yakalar (izin istemeden)
    if (AKEY[e.code] || AKEY[e.key]) {
      e.preventDefault();
      control(t, { t: 'keycode', code: AKEY[e.code] || AKEY[e.key], meta: metaOf(e) });
      return;
    }
    if (ctrl || e.altKey) {
      const code = androidKeyFromLetter(e.key);
      if (code) {
        e.preventDefault();
        control(t, { t: 'keycode', code, meta: metaOf(e) });
      }
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      // ASCII doğrudan; Türkçe ve diğer karakterler pano üzerinden yapıştırılır
      control(t, /^[\x20-\x7e]$/.test(e.key) ? { t: 'text', text: e.key } : { t: 'paste', text: e.key });
    }
  });
}

document.addEventListener('paste', (e) => {
  const t = [...tiles.values()].find((x) => x.canvas === document.activeElement || x.img === document.activeElement);
  if (!t || !t.live) return;
  const text = e.clipboardData?.getData('text');
  if (!text) return;
  e.preventDefault();
  control(t, { t: 'paste', text: text.slice(0, 100000) });
  toast(`Yapıştırıldı (${text.length} karakter)`);
});

function bindInput(t, el) {
  bindKeyboard(t, el);
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    const big = S.big === t.serial;
    if (!big) {
      // Küçük ekranda çift tıklama = büyüt (cihaza dokunma olarak gitmez)
      const now = performance.now();
      if (t.lastClick && now - t.lastClick < 300) {
        clearTimeout(t.tapTimer);
        t.lastClick = 0;
        t.down = null;
        return toggleBig(t.serial);
      }
      t.lastClick = now;
      if (t.serial !== S.focus) return setFocus(t.serial);
    }
    el.setPointerCapture(e.pointerId);
    const p = norm(e, el);
    // Büyük ekranda dokunma anında (canlı) gider; küçükte çift tıklamayı ayırt etmek için bırakınca
    t.down = { ...p, at: performance.now(), live: t.live && big, small: !big };
    if (t.down.live) control(t, { t: 'touch', a: 0, ...p });
  });
  el.addEventListener('pointermove', (e) => {
    if (!t.down?.live) return;
    control(t, { t: 'touch', a: 2, ...norm(e, el) });
  });
  el.addEventListener('pointerup', (e) => {
    if (!t.down) return;
    const p = norm(e, el);
    const dt = performance.now() - t.down.at;
    const dist = Math.hypot(p.x - t.down.x, p.y - t.down.y);
    let a;
    if (dist < 0.012) a = dt >= 500 ? { type: 'longpress', x: p.x, y: p.y, ms: clamp(Math.round(dt), 500, 5000) } : { type: 'tap', x: p.x, y: p.y };
    else a = { type: 'swipe', x1: t.down.x, y1: t.down.y, x2: p.x, y2: p.y, ms: clamp(Math.round(dt), 60, 3000) };
    const live = t.down.live;
    const small = t.down.small;
    const start = { x: t.down.x, y: t.down.y };
    t.down = null;
    showTouch(t, p);
    if (live) {
      control(t, { t: 'touch', a: 1, ...p });
      act(a, t.serial, true);
    } else if (small && t.live) {
      // Küçük ekran: dokunmayı kanaldan hareket olarak gönder; tek tıklama çift tıklama olmadığı anlaşılınca gider
      const send = () => {
        control(t, { t: 'touch', a: 0, ...start });
        if (a.type === 'swipe') for (let i = 1; i <= 8; i++) control(t, { t: 'touch', a: 2, x: start.x + ((p.x - start.x) * i) / 8, y: start.y + ((p.y - start.y) * i) / 8 });
        control(t, { t: 'touch', a: 1, ...p });
        act(a, t.serial, true);
      };
      if (a.type === 'tap') t.tapTimer = setTimeout(send, 280);
      else send();
    } else act(a, t.serial);
  });

  // Büyük ekranda: çerçeveye ya da isim satırına çift tıklama = küçült (ekranın içi cihaza çift dokunma olarak gider)
  if (!t.dblBound) {
    t.dblBound = true;
    const shrink = (e) => {
      if (S.big === t.serial && e.target !== t.canvas && e.target !== t.img && e.target !== t.bigBtn) toggleBig(t.serial);
    };
    t.bezel.addEventListener('dblclick', shrink);
    t.el.querySelector('.plate').addEventListener('dblclick', shrink);
  }
  el.addEventListener('pointercancel', (e) => {
    if (t.down?.live) control(t, { t: 'touch', a: 1, ...norm(e, el) });
    t.down = null;
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (t.serial !== S.focus) return;
    if (t.live) {
      control(t, { t: 'key', key: 'back' });
      act({ type: 'key', key: 'back' }, t.serial, true);
    } else act({ type: 'key', key: 'back' }, t.serial);
  });
  el.addEventListener(
    'wheel',
    (e) => {
      if (t.serial !== S.focus) return;
      e.preventDefault();
      if (t.live) {
        const p = norm(e, el);
        control(t, { t: 'scroll', x: p.x, y: p.y, v: clamp(-e.deltaY / 40, -16, 16) });
        return;
      }
      t.wheel = (t.wheel || 0) + e.deltaY;
      clearTimeout(t.wheelTimer);
      t.wheelTimer = setTimeout(() => {
        const p = norm(e, el);
        const dy = clamp(t.wheel / 1200, -0.45, 0.45);
        t.wheel = 0;
        act({ type: 'swipe', x1: p.x, y1: clamp(p.y, 0.2, 0.8), x2: p.x, y2: clamp(p.y - dy, 0.05, 0.95), ms: 220 }, t.serial);
      }, 110);
    },
    { passive: false }
  );
}

// Ekrandan gelen eylem: makroya kaydedilir; Ayna açıksa işaretli diğer cihazlara da gider.
// selfDone: odaktaki cihaza canlı kanaldan zaten uygulandı.
async function act(a, fromSerial, selfDone = false) {
  record(a);
  const mirror = $('#mirror').checked ? targetList() : [];
  const targets = [...new Set([...(selfDone ? [] : [fromSerial]), ...mirror])].filter((s) => !(selfDone && s === fromSerial));
  if (!targets.length) return;
  try {
    const { results } = await api('POST', '/api/act', { targets, action: a });
    const bad = results.filter((r) => !r.ok);
    if (bad.length) toast(`${bad.map((r) => labelOf(r.serial)).join(', ')}: ${bad[0].error}`, true);
  } catch (e) {
    fail(e);
  }
}

// Panel düğmeleri: hedeflerin hepsine. Tuşlar canlı bağlantısı olan cihazlara anında gider.
async function actTargets(a, out) {
  try {
    let targets = needTargets();
    const fast = [];
    if (a.type === 'key' || a.type === 'text') {
      for (const s of targets) {
        const t = tiles.get(s);
        if (t?.live) {
          // Metin canlı cihaza pano üzerinden gider: Türkçe karakterler de çalışır
          control(t, a.type === 'key' ? { t: 'key', key: a.key } : { t: 'paste', text: a.text });
          fast.push({ serial: s, ok: true, out: '' });
        }
      }
      targets = targets.filter((s) => !fast.some((f) => f.serial === s));
    }
    const results = targets.length ? (await api('POST', '/api/act', { targets, action: a })).results : [];
    results.push(...fast);
    record(a);
    if (out) showResults(out, results);
    const bad = results.filter((r) => !r.ok);
    if (bad.length && !out) toast(`${bad.map((r) => labelOf(r.serial)).join(', ')}: ${bad[0].error}`, true);
    return results;
  } catch (e) {
    fail(e);
  }
}

function showResults(box, results) {
  box.replaceChildren(
    ...results.map((r) =>
      h('div', { class: `result${r.ok ? '' : ' fail'}` }, h('b', null, labelOf(r.serial)), h('pre', null, (r.ok ? r.out : r.error) || (r.ok ? '✓ tamam' : 'hata')))
    )
  );
}

// ---------- Makro kaydı ----------
// Adımlar zamanıyla ("at") tutulur: paneldeki dokunuşlar ve emülatör penceresindeki dokunuşlar
// (sunucu getevent ile okur) kayıt bitince zaman sırasına göre birleştirilir.
function record(a) {
  if (!S.rec || S.rec.stopped) return;
  S.rec.steps.push({ ...a, at: Date.now() });
  recSay();
}
const recSay = () => ($('#recCount').textContent = `${S.rec.steps.length + (S.rec.cihaz || 0)} adım`);

async function toggleRec() {
  if (S.rec) {
    if (S.rec.stopped) return;
    $('#recBtn').classList.remove('on');
    $('#recBtn').textContent = '● Kaydet';
    S.rec.stopped = true;
    try {
      const { steps } = await api('POST', '/api/kayit/bitir');
      S.rec.steps.push(...steps);
    } catch {}
    S.rec.steps.sort((a, b) => a.at - b.at);
    S.rec.cihaz = 0;
    recSay();
    if (!S.rec.steps.length) {
      S.rec = null;
      $('#recBox').hidden = true;
      return;
    }
    switchTab('makro');
    $('#recName').focus();
    return;
  }
  S.rec = { steps: [], cihaz: 0 };
  $('#recBtn').classList.add('on');
  $('#recBtn').textContent = '■ Durdur';
  $('#recBox').hidden = false;
  $('#recCount').textContent = '0 adım';
  const r = await api('POST', '/api/kayit/basla').catch(() => ({ cihaz: 0 }));
  toast(r.cihaz ? 'Kayıt başladı: paneldeki ve emülatör pencerelerindeki dokunuşların kaydediliyor' : 'Kayıt başladı: odaktaki ekranda yaptıkların kaydediliyor');
}

async function saveRec() {
  const name = $('#recName').value.trim();
  if (!S.rec?.steps.length) return toast('Kaydedilecek adım yok', true);
  if (!name) return toast('Makroya bir ad ver', true);
  if (!S.rec.stopped) await toggleRec();
  if (!S.rec?.steps.length) return;
  // Gecikme = bir önceki adımdan bu yana geçen süre (ilk adım hemen)
  const steps = S.rec.steps.map(({ at, delay, ...s }, i, a) => ({ ...s, delay: i === 0 ? 0 : Math.max(0, Math.round(at - a[i - 1].at)) }));
  try {
    await api('POST', '/api/macros', { name, steps });
    toast(`"${name}" kaydedildi`);
    S.rec = null;
    $('#recBox').hidden = true;
    $('#recName').value = '';
    loadMacros();
  } catch (e) {
    fail(e);
  }
}

async function loadMacros() {
  try {
    const { macros, jobs } = await api('GET', '/api/macros');
    for (const j of jobs) S.jobs.set(j.id, j);
    const ul = $('#macrolist');
    ul.replaceChildren();
    if (!macros.length) ul.append(h('li', { class: 'hint' }, 'Henüz makro yok.'));
    for (const m of macros) {
      ul.append(
        h(
          'li',
          null,
          h('span', { class: 'n' }, m.name, h('small', null, `${m.steps} adım · ~${Math.round(m.duration / 1000)} sn`)),
          h('button', { onclick: () => runMacro(m.name) }, '▶ Çalıştır'),
          h(
            'button',
            {
              class: 'danger',
              onclick: async () => {
                if (!confirm(`"${m.name}" silinsin mi?`)) return;
                await api('DELETE', `/api/macros/${encodeURIComponent(m.name)}`).catch(fail);
                loadMacros();
              },
            },
            'Sil'
          )
        )
      );
    }
    renderJobs();
  } catch (e) {
    fail(e);
  }
}

async function runMacro(name) {
  try {
    const repeat = Number($('#macroRepeat').value) || 1;
    const j = await api('POST', '/api/macros/run', { name, targets: needTargets(), repeat });
    S.jobs.set(j.id, j);
    renderJobs();
  } catch (e) {
    fail(e);
  }
}

function renderJobs() {
  const ul = $('#joblist');
  ul.replaceChildren();
  const list = [...S.jobs.values()].reverse();
  if (!list.length) ul.append(h('li', { class: 'hint' }, 'Çalışan görev yok.'));
  for (const j of list) {
    const done = Object.values(j.progress).reduce((a, b) => a + b, 0);
    const total = j.total * j.targets.length;
    const state = { running: 'çalışıyor', done: 'bitti', stopped: 'durduruldu', error: 'hata' }[j.state];
    const errs = Object.entries(j.errors || {}).map(([s, e]) => `${labelOf(s)}: ${e}`);
    ul.append(
      h(
        'li',
        null,
        h('span', { class: 'n' }, `${j.name} × ${j.repeat}`, h('small', null, `${state} · ${done}/${total} adım · ${j.targets.length} cihaz`), errs.length ? h('small', { class: 'fail' }, errs.join(' | ')) : null),
        j.state === 'running' ? h('button', { class: 'danger', onclick: () => api('POST', `/api/jobs/${j.id}/stop`, {}).catch(fail) }, 'Durdur') : null
      )
    );
  }
}

// ---------- Uygulamalar ----------
let appsFor = null;
async function loadApps(force = false) {
  const ul = $('#applist');
  if (!S.focus) return ul.replaceChildren(h('li', { class: 'hint' }, 'Odakta cihaz yok.'));
  const key = `${S.focus}|${$('#appAll').checked}`;
  if (!force && appsFor === key) return filterApps();
  appsFor = key;
  ul.replaceChildren(h('li', { class: 'hint' }, 'Okunuyor…'));
  try {
    const { apps } = await api('GET', `/api/d/${encodeURIComponent(S.focus)}/apps${$('#appAll').checked ? '?all=1' : ''}`);
    ul.replaceChildren(
      ...apps.map((pkg) =>
        h(
          'li',
          { 'data-pkg': pkg },
          h('span', { class: 'pkg', title: pkg }, pkg),
          h('button', { onclick: () => actTargets({ type: 'launch', pkg }) }, 'Aç'),
          h('button', { onclick: () => actTargets({ type: 'stop', pkg }) }, 'Durdur'),
          h('button', { title: 'Uygulama verisini sil', onclick: () => confirm(`${pkg} verisi tüm hedeflerde silinsin mi?`) && actTargets({ type: 'clear', pkg }) }, 'Sıfırla'),
          h(
            'button',
            {
              class: 'danger',
              onclick: async () => {
                if (!confirm(`${pkg} tüm hedeflerden kaldırılsın mı?`)) return;
                await actTargets({ type: 'uninstall', pkg });
                loadApps(true);
              },
            },
            'Kaldır'
          ),
          h('button', { title: 'Logcat bu uygulamayı izlesin', onclick: () => ((($('#logPkg').value = pkg), switchTab('log'))) }, 'Log')
        )
      )
    );
    if (!apps.length) ul.append(h('li', { class: 'hint' }, 'Yüklü uygulama yok.'));
    filterApps();
  } catch (e) {
    ul.replaceChildren(h('li', { class: 'hint' }, e.message));
  }
}
function filterApps() {
  const f = $('#appFilter').value.trim().toLowerCase();
  for (const li of $$('#applist li[data-pkg]')) li.hidden = f && !li.dataset.pkg.toLowerCase().includes(f);
}

// ---------- Logcat ----------
let logES = null;
let logLines = [];
function logStart() {
  logStop();
  if (!S.focus) return toast('Odakta cihaz yok', true);
  const pkg = $('#logPkg').value.trim();
  const qs = new URLSearchParams({ level: $('#logLevel').value });
  if (pkg) qs.set('pkg', pkg);
  logLines = [];
  $('#logview').replaceChildren();
  const serial = S.focus;
  logES = new EventSource(`/api/d/${encodeURIComponent(serial)}/logcat?${qs}`);
  logES.addEventListener('lines', (e) => {
    const lines = JSON.parse(e.data);
    logLines.push(...lines);
    if (logLines.length > 5000) logLines = logLines.slice(-5000);
    appendLog(lines);
  });
  logES.addEventListener('end', () => logStop());
  logES.onerror = async () => {
    if (!logES) return;
    logStop();
    // Hata ayrıntısını öğrenmek için aynı isteği bir kez normal fetch ile dene
    const res = await fetch(`/api/d/${encodeURIComponent(serial)}/logcat?${qs}`).catch(() => null);
    if (res && !res.ok) toast((await res.json().catch(() => ({}))).error || 'Logcat durdu', true);
    else res?.body?.cancel();
  };
  toast(`Logcat: ${labelOf(serial)}${pkg ? ` · ${pkg}` : ''}`);
}
function logStop() {
  if (logES) logES.close();
  logES = null;
}
function appendLog(lines) {
  const view = $('#logview');
  const f = $('#logFind').value.trim().toLowerCase();
  const stick = view.scrollTop + view.clientHeight >= view.scrollHeight - 30;
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    if (f && !line.toLowerCase().includes(f)) continue;
    const m = line.match(/^(\S+ \S+)\s+([VDIWEF])\/([^(]+)(\(\s*\d+\)):?\s?(.*)$/);
    if (m) frag.append(h('div', { class: m[2] }, `${m[1]} ${m[2]} `, h('span', { class: 'src' }, m[3].trim()), `: ${m[5]}`));
    else frag.append(h('div', null, line));
  }
  view.append(frag);
  while (view.childElementCount > 5000) view.firstChild.remove();
  if (stick) view.scrollTop = view.scrollHeight;
}

// ---------- Emülatörler ----------
async function loadAvds() {
  try {
    const { avds, images } = await api('GET', '/api/emu');
    const ul = $('#avdlist');
    ul.replaceChildren();
    if (!images.length) ul.append(h('li', { class: 'hint' }, 'Sistem imajı yok (Android Studio › SDK Manager).'));
    if (!avds.length && images.length) ul.append(h('li', { class: 'hint' }, 'Henüz sanal cihaz yok.'));
    for (const a of avds) {
      ul.append(
        h(
          'li',
          { class: 'avd' },
          h('span', { class: `dot${a.serial ? ' on' : ''}` }),
          h(
            'span',
            { class: 'n', title: a.deep ? `${a.name} — derin uykuda: durumu kayıtlı, işlemci %0` : a.proxy ? `${a.name} — çıkış: ${a.proxy}` : a.name },
            a.name,
            a.proxy ? h('small', { class: 'via' }, ` ⇢ ${a.proxy}`) : null,
            a.deep ? h('small', { class: 'via' }, ' 💤 derin uyku') : null
          ),
          a.serial
            ? h('button', { onclick: () => api('POST', '/api/emu/stop', { serial: a.serial }).then(() => setTimeout(loadAvds, 1500), fail) }, 'Kapat')
            : h(
                'button',
                {
                  class: a.deep ? 'primary' : null,
                  onclick: () =>
                    api('POST', '/api/emu/start', { name: a.name, headless: $('#emuNew').headless.checked, proxy: $('#proxySel').value || undefined })
                      .then(() => toast(a.deep ? `${a.name} uyanıyor (kaldığı yerden, ~10 sn)` : `${a.name} açılıyor (ilk açılış ~1 dk)`))
                      .catch(fail),
                },
                a.deep ? '💤 Uyandır' : 'Başlat'
              ),
          a.serial
            ? null
            : h(
                'button',
                {
                  class: 'danger',
                  title: 'Sil',
                  onclick: async () => {
                    if (!confirm(`${a.name} ve içindeki tüm veriler silinsin mi?`)) return;
                    await api('POST', '/api/emu/delete', { name: a.name }).catch(fail);
                    loadAvds();
                  },
                },
                '✕'
              )
        )
      );
    }
  } catch (e) {
    fail(e);
  }
}


// ---------- Google Play hesabı ----------
// Giriş, şablon emülatörün kendi penceresinde yapılır: şifre bu panelden hiç geçmez.
async function loadAccount() {
  const box = $('#acct');
  try {
    const a = await api('GET', '/api/account');
    const fromT = $('#emuNew').fromTemplate;
    fromT.disabled = !a.ready || !!a.serial;
    if (a.ready && !a.serial && !S.acctTouched) fromT.checked = true;
    if (!a.ready) fromT.checked = false;
    box.className = `acct${a.serial ? ' open' : a.ready ? ' ready' : ''}`;
    const busy = (btn, fn) => async () => {
      btn.disabled = true;
      try {
        await fn();
      } catch (e) {
        fail(e);
      } finally {
        btn.disabled = false;
        loadAccount();
      }
    };
    if (a.serial) {
      const save = h('button', { class: 'primary' }, 'Girişi tamamladım, kaydet');
      save.onclick = busy(save, async () => {
        toast('Hesap kaydediliyor, şablon kapatılıyor…');
        const r = await api('POST', '/api/account/save', {});
        toast(`Kaydedildi: ${r.email}. Yeni emülatörler bu hesapla açılacak.`);
      });
      box.replaceChildren(
        h('div', { class: 'who' }, h('span', null, 'Şablon açık')),
        h('p', null, "Açılan emülatör penceresinde Play Store'a kendi Gmail'inle giriş yap. Şifreni doğrudan o pencereye yaz. \"Kaydet\"e basınca Opera şablona otomatik kurulur, sonra şablon kaydedilir."),
        h('p', { id: 'sablonDurum', class: 'via' }),
        save
      );
    } else if (a.ready) {
      const redo = h('button', null, 'Hesabı değiştir');
      redo.onclick = busy(redo, async () => {
        await api('POST', '/api/account/open', {});
        toast('Şablon açılıyor — pencerede hesabı değiştirip "Kaydet"e bas');
      });
      box.replaceChildren(
        h('div', { class: 'who', title: a.email }, h('span', null, a.email)),
        h('p', null, `Kaydedildi: ${new Date(a.savedAt).toLocaleString('tr-TR')}. Yeni emülatörler bu hesapla ve Türkçe açılır.`),
        h('div', { class: 'row' }, redo)
      );
    } else {
      const open = h('button', { class: 'primary' }, 'Play Store girişini aç');
      open.onclick = busy(open, async () => {
        await api('POST', '/api/account/open', {});
        toast('Şablon emülatör açılıyor (ilk açılış 1–2 dk). Play Store açılınca giriş yap.');
      });
      box.replaceChildren(
        h('div', { class: 'who' }, h('span', null, 'Hesap yok')),
        h('p', null, "Bir kez kendi Gmail'inle giriş yap; sonra açacağın tüm emülatörler bu hesapla gelir. Şifren bu panelden geçmez."),
        open
      );
    }
  } catch (e) {
    box.replaceChildren(h('p', null, e.message));
  }
}


// ---------- Ağ çıkışları ----------
async function loadProxies() {
  try {
    const { proxies } = await api('GET', '/api/proxies');
    const sel = $('#proxySel');
    const cur = sel.value;
    sel.replaceChildren(
      h('option', { value: '' }, 'Doğrudan (bu bilgisayar)'),
      ...(proxies.length > 1 ? [h('option', { value: 'sirayla' }, `Sırayla dağıt (${proxies.length} çıkış)`)] : []),
      ...proxies.map((p) => h('option', { value: p.id }, p.name))
    );
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
    const ul = $('#proxyList');
    ul.replaceChildren(
      ...proxies.map((p) =>
        h(
          'li',
          { class: 'avd' },
          h('span', { class: 'n', title: p.url }, p.name, h('small', { class: 'via' }, ` ${p.url}${p.tz ? ' · ' + p.tz : ''}`)),
          h(
            'button',
            {
              class: 'danger',
              title: 'Sil',
              onclick: async () => {
                if (!confirm(`"${p.name}" silinsin mi?`)) return;
                await api('DELETE', `/api/proxies/${p.id}`).catch(fail);
                loadProxies();
              },
            },
            '✕'
          )
        )
      )
    );
    if (!proxies.length) ul.append(h('li', { class: 'hint' }, 'Kayıtlı çıkış yok — emülatörler doğrudan bağlanır.'));
  } catch (e) {
    fail(e);
  }
}


// ---------- Emülatör bileşenleri (başka bilgisayara kurulumda) ----------
async function loadSdk() {
  const box = $('#sdkBox');
  try {
    const st = await api('GET', '/api/sdk');
    const missing = [!st.emulator && 'Android emülatörü (~450 MB)', !st.image && 'Android 15 Play Store imajı (~1,7 GB)'].filter(Boolean);
    const accelBad = st.accel && !st.accel.ok;
    box.hidden = !missing.length && !accelBad && !st.busy;
    if (box.hidden) return;
    const kids = [];
    if (missing.length) {
      kids.push(h('div', { class: 'who' }, h('span', null, 'Emülatör bileşenleri eksik')));
      kids.push(h('p', null, `Sanal cihaz için gerekli: ${missing.join(', ')}. Yalnızca Google'ın resmî sunucusundan indirilir ve doğrulanır. Telefon kontrolü için gerekmez.`));
      const btn = h('button', { class: 'primary', disabled: st.busy }, st.busy ? 'İndiriliyor…' : 'İndir ve kur');
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = 'İndiriliyor…';
        await api('POST', '/api/sdk/install', {}).catch(fail);
      };
      kids.push(btn, h('div', { class: 'progress', id: 'sdkProg' }, h('span')), h('p', { id: 'sdkMsg' }));
    }
    if (accelBad) {
      kids.push(h('div', { class: 'who' }, h('span', null, 'Donanım hızlandırma kapalı')));
      kids.push(h('p', null, "Emülatör için: Başlat › \"Windows özelliklerini aç veya kapat\" › \"Windows Hiper Yönetici Platformu\" işaretle, yeniden başlat. BIOS'ta sanallaştırma (VT-x / SVM) açık olmalı."));
    }
    box.className = 'acct';
    box.replaceChildren(...kids);
  } catch (e) {
    box.hidden = true;
  }
}

// ---------- Güvenlik ----------
async function loadSecurity() {
  try {
    const { checks } = await api('GET', '/api/security');
    const ul = $('#checks');
    ul.replaceChildren(
      ...checks.map((c) =>
        h(
          'li',
          { class: c.level },
          h('span', { class: 'dot' }),
          h('span', { class: 't' }, c.title),
          h('span', { class: 'd' }, c.detail),
          c.fix
            ? h(
                'button',
                {
                  onclick: () =>
                    api('POST', '/api/security/fix', { id: c.fix.id, serial: c.fix.serial })
                      .then(() => (toast('Düzeltildi'), setTimeout(loadSecurity, 1500)))
                      .catch(fail),
                },
                c.fix.label
              )
            : null
        )
      )
    );
    renderLamps(checks);
  } catch (e) {
    renderLamps(null);
  }
}

function renderLamps(checks) {
  const lamps = $('#lamps');
  const worst = (pred) => {
    const list = (checks || []).filter(pred);
    if (!checks) return '';
    if (!list.length) return 'ok';
    return list.some((c) => c.level === 'bad') ? 'bad' : list.some((c) => c.level === 'warn') ? 'warn' : 'ok';
  };
  const items = [
    ['Yerel', worst((c) => ['panel', 'adb', 'emu-ports', 'firewall'].includes(c.id))],
    ['Wi-Fi adb', worst((c) => c.id.startsWith('wifi:') || c.id.startsWith('net:'))],
    ['Pano', worst((c) => c.id === 'clipboard')],
    ['Telemetri', worst((c) => c.id === 'metrics')],
    ['Dış bağlantı yok', worst((c) => c.id === 'outbound')],
  ];
  lamps.replaceChildren(...items.map(([t, lv]) => h('span', { class: `lamp ${lv}` }, t)));
}

// ---------- Kayıt ----------
function addAudit(e, prepend = true) {
  const ul = $('#auditlist');
  const time = new Date(e.t).toLocaleTimeString('tr-TR');
  const li = h(
    'li',
    { class: e.ok ? '' : 'fail' },
    h('time', null, time),
    e.action,
    e.targets.length ? h('small', null, e.targets.map(labelOf).join(', ')) : null,
    e.detail ? h('small', null, e.detail) : null
  );
  prepend ? ul.prepend(li) : ul.append(li);
  while (ul.childElementCount > 300) ul.lastChild.remove();
}

// ---------- Yükleme ----------
async function upload(kind, files) {
  let targets;
  try {
    targets = needTargets();
  } catch (e) {
    return fail(e);
  }
  const bar = $('#upProgress');
  for (const file of files) {
    bar.hidden = false;
    bar.firstElementChild.style.width = '0%';
    // XHR: yükleme ilerlemesini göstermek için
    const res = await new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('POST', `/api/upload?kind=${kind}&targets=${encodeURIComponent(targets.join(','))}`);
      x.setRequestHeader('x-mobilmotor', '1');
      x.setRequestHeader('x-filename', encodeURIComponent(file.name));
      x.setRequestHeader('content-type', 'application/octet-stream');
      x.upload.onprogress = (e) => e.lengthComputable && (bar.firstElementChild.style.width = `${(e.loaded / e.total) * 100}%`);
      x.onload = () => resolve({ status: x.status, body: JSON.parse(x.responseText || '{}') });
      x.onerror = () => resolve({ status: 0, body: { error: 'Yükleme başarısız' } });
      x.send(file);
    });
    bar.firstElementChild.style.width = '100%';
    if (res.status !== 200) fail(new Error(res.body.error));
    else {
      showResults($('#ctlResults'), res.body.results);
      const ok = res.body.results.filter((r) => r.ok).length;
      toast(`${file.name}: ${ok}/${res.body.results.length} cihazda ${kind === 'apk' ? 'kuruldu' : 'Download klasörüne gönderildi'}`, ok < res.body.results.length);
    }
  }
  setTimeout(() => (bar.hidden = true), 800);
  if (kind === 'apk' && S.tab === 'uygulama') loadApps(true);
}

// ---------- Sekmeler ----------
function switchTab(name) {
  S.tab = name;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach((s) => s.classList.toggle('on', s.dataset.tab === name));
  if (name === 'uygulama') loadApps();
  if (name === 'makro') loadMacros();
  if (name === 'guvenlik') loadSecurity();
}

// ---------- Başlangıç ----------
function bindUi() {
  $('#tabs').addEventListener('click', (e) => e.target.dataset.tab && switchTab(e.target.dataset.tab));
  $('#lamps').addEventListener('click', () => switchTab('guvenlik'));
  $('#stream').addEventListener('change', (e) => ((S.stream = e.target.value), refreshStreams()));
  $('#recBtn').addEventListener('click', toggleRec);
  $('#recSave').addEventListener('click', saveRec);
  $('#recWait').addEventListener('click', () => {
    if (!S.rec) return;
    if (S.rec.stopped) return;
    S.rec.steps.push({ type: 'wait', ms: 1000, at: Date.now() });
    recSay();
  });
  $('#mirror').addEventListener('change', (e) => e.target.checked && !S.targets.size && toast('Ayna için raftan birden çok cihaz işaretle'));
  $('#selAll').addEventListener('click', () => {
    const all = ready().map((d) => d.serial);
    const every = all.every((s) => S.targets.has(s));
    S.targets = new Set(every ? [] : all);
    renderRail();
    renderStage();
    renderTargetLine();
  });

  $$('.keys button').forEach((b) =>
    b.addEventListener('click', () => actTargets(b.dataset.key ? { type: 'key', key: b.dataset.key } : { type: b.dataset.act }))
  );
  $('#textForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.text.value) return;
    const r = await actTargets({ type: 'text', text: f.text.value });
    if (r && f.enter.checked) await actTargets({ type: 'key', key: 'enter' });
    if (r?.every((x) => x.ok)) f.text.value = '';
  });
  $('#urlForm').addEventListener('submit', (e) => {
    e.preventDefault();
    actTargets({ type: 'url', url: e.target.url.value });
  });
  $('#shellForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const cmd = e.target.cmd.value.trim();
    if (cmd) actTargets({ type: 'shell', cmd }, $('#shellResults'));
  });
  $('#shellForm').cmd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.target.form.requestSubmit();
  });

  $('#apkBtn').addEventListener('click', () => $('#apkFile').click());
  $('#pushBtn').addEventListener('click', () => $('#pushFile').click());
  $('#apkFile').addEventListener('change', (e) => (upload('apk', [...e.target.files]), (e.target.value = '')));
  $('#pushFile').addEventListener('change', (e) => (upload('file', [...e.target.files]), (e.target.value = '')));
  $('#capBtn').addEventListener('click', () =>
    S.focus ? api('POST', `/api/d/${encodeURIComponent(S.focus)}/capture`, {}).then((r) => toast(`Kaydedildi: ${r.name}`), fail) : toast('Odakta cihaz yok', true)
  );
  $('#scrcpyBtn').addEventListener('click', () =>
    S.focus ? api('POST', `/api/d/${encodeURIComponent(S.focus)}/scrcpy`, {}).then(() => toast('Akıcı pencere açılıyor'), fail) : toast('Odakta cihaz yok', true)
  );
  $$('[data-folder]').forEach((b) => b.addEventListener('click', () => api('POST', '/api/open-folder', { which: b.dataset.folder }).catch(fail)));

  $('#appFilter').addEventListener('input', filterApps);
  $('#appAll').addEventListener('change', () => loadApps(true));

  $('#logStart').addEventListener('click', logStart);
  $('#logStop').addEventListener('click', () => (logStop(), toast('Logcat durdu')));
  $('#logClear').addEventListener('click', () => {
    $('#logview').replaceChildren();
    logLines = [];
    if (S.focus) api('POST', '/api/logcat/clear', { targets: [S.focus] }).catch(() => {});
  });
  $('#logFind').addEventListener('input', () => {
    $('#logview').replaceChildren();
    appendLog(logLines);
  });

  $('#secRefresh').addEventListener('click', loadSecurity);
  $('#emuRefresh').addEventListener('click', loadAvds);
  $('#emuNew').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const { created } = await api('POST', '/api/emu/create', {
        name: f.avdname.value.trim(),
        profile: f.profile.value,
        count: Number(f.count.value) || 1,
        headless: f.headless.checked,
        fromTemplate: f.fromTemplate.checked,
        proxy: f.proxy.value || undefined,
        start: true,
      });
      toast(`${created.map((c) => c.name).join(', ')} oluşturuldu${f.fromTemplate.checked ? ' (Google hesabıyla)' : ''}, açılıyor (ilk açılış 1–2 dk)`);
      loadAvds();
    } catch (err) {
      fail(err);
    } finally {
      btn.disabled = false;
    }
  });
}

async function init() {
  bindUi();
  const st = await api('GET', '/api/state');
  S.devices = st.devices;
  S.hidden = st.hidden;
  S.adbError = st.adbError;
  S.profiles = st.profiles;
  $('#emuNew').profile.replaceChildren(...Object.entries(st.profiles).map(([k, p]) => h('option', { value: k }, `${p.label} ${p.width}×${p.height}`)));
  for (const j of st.jobs) S.jobs.set(j.id, j);
  st.audit.forEach((e) => addAudit(e));
  if (!st.scrcpy) $('#scrcpyBtn').disabled = true;
  onDevices();
  loadAvds();
  loadAccount();
  $('#emuNew').fromTemplate.addEventListener('change', () => (S.acctTouched = true));
  loadProxies();
  loadSdk();
  api('GET', '/api/ayarlar').then(
    (a) => {
      $('#hafifMod').checked = a.hafif;
      $('#chromeKoru').checked = a.chromeKoru !== false;
      $('#uykuSel').value = String(a.uyku);
      $('#derinUyku').checked = a.derin;
      $('#bellekSel').value = String(a.bellek || 'otomatik');
      $('#bellekSel').options[0].textContent = `Otomatik (${a.dusukRam ? 'bu bilgisayarda 3 GB' : 'bu bilgisayarda 4 GB'})`;
      S.uyanik = a.uyanik || [];
      renderRail();
      renderUyanik();
    },
    () => {}
  );
  $('#uyanikCb').addEventListener('change', async (e) => {
    const d = dev(S.focus);
    if (!d?.avd) return;
    try {
      const a = await api('POST', '/api/ayarlar', { uyanik: { name: d.avd, on: e.target.checked } });
      S.uyanik = a.uyanik;
      renderRail();
      toast(e.target.checked ? `${d.avd} uyutulmayacak: arkada çalışmaya devam eder` : `${d.avd} yeniden otomatik uykuya girebilir`);
    } catch (err) {
      e.target.checked = !e.target.checked;
      fail(err);
    }
  });
  $('#chromeKoru').addEventListener('change', async (e) => {
    try {
      await api('POST', '/api/ayarlar', { chromeKoru: e.target.checked });
      toast(e.target.checked ? "Chrome kendiliğinden kapanırsa yeniden açılacak" : 'Chrome koruması kapalı');
    } catch (err) {
      e.target.checked = !e.target.checked;
      fail(err);
    }
  });
  $('#derinUyku').addEventListener('change', async (e) => {
    try {
      await api('POST', '/api/ayarlar', { derin: e.target.checked });
      toast(e.target.checked ? 'Derin uyku açık' : 'Derin uyku kapalı');
    } catch (err) {
      e.target.checked = !e.target.checked;
      fail(err);
    }
  });
  $('#bellekSel').addEventListener('change', async (e) => {
    const v = e.target.value === 'otomatik' ? 'otomatik' : Number(e.target.value);
    try {
      await api('POST', '/api/ayarlar', { bellek: v });
      toast('Emülatör belleği değişti: açık emülatörlerde bir sonraki açılışta geçerli olur');
    } catch (err) {
      fail(err);
    }
  });
  $('#uykuSel').addEventListener('change', async (e) => {
    const v = Number(e.target.value);
    try {
      await api('POST', '/api/ayarlar', { uyku: v });
      toast(v ? `Kullanılmayan emülatörler ${v} dk sonra uyutulacak` : 'Otomatik uyku kapalı');
    } catch (err) {
      fail(err);
    }
  });
  $('#hafifMod').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      await api('POST', '/api/ayarlar', { hafif: on });
      toast(on ? 'Hafif mod açık: açık emülatörlere uygulanıyor' : 'Hafif mod kapalı: değişiklikler geri alındı');
    } catch (err) {
      e.target.checked = !on;
      fail(err);
    }
  });
  $('#proxyToggle').addEventListener('click', () => ($('#proxyForm').hidden = !$('#proxyForm').hidden));
  // Motoru sıfırla: "Emin misiniz?" penceresi — silinecekler listelenir, kutu işaretlenmeden düğme açılmaz
  const dlg = $('#sifirlaDlg');
  // Play Store'dan kur (hesap açık olmalı)
  const playKur = async (pkg) => {
    try {
      if (!/^[a-zA-Z]\w*(\.[a-zA-Z_]\w*)+$/.test(pkg)) throw new Error('Geçersiz paket adı (örn. com.opera.browser)');
      await api('POST', '/api/play-kur', { targets: needTargets(), pkg });
      $('#playDurum').textContent = `${pkg}: Play Store'dan kuruluyor…`;
    } catch (err) {
      fail(err);
    }
  };
  $('#playForm').addEventListener('submit', (e) => {
    e.preventDefault();
    playKur(e.target.pkg.value.trim());
  });
  $('#playOpera').addEventListener('click', () => playKur('com.opera.browser'));
  $('#sifirlaBtn').addEventListener('click', async () => {
    try {
      const p = await api('GET', '/api/sifirla');
      const gb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
      $('#sifirlaList').replaceChildren(
        ...(p.avds.length ? p.avds.map((a) => h('li', null, `Sanal cihaz: ${a.name} (${gb(a.mb)})`)) : [h('li', null, 'Sanal cihaz yok')]),
        h('li', null, `${p.makro} makro, ${p.goruntu} ekran görüntüsü, ${p.kayit} kayıt dosyası`),
        h('li', null, `${p.agCikisi} ağ çıkışı${p.hesap ? ', Google hesap şablonu bilgisi' : ''}`),
        h('li', null, 'Tüm ayarlar (hafif mod, uyku, uyutma listesi)')
      );
      $('#sifirlaOnay').checked = false;
      $('#sifirlaEvet').disabled = true;
      $('#sifirlaVazgec').disabled = false;
      $('#sifirlaDurum').textContent = '';
      dlg.showModal();
    } catch (err) {
      fail(err);
    }
  });
  $('#sifirlaOnay').addEventListener('change', (e) => ($('#sifirlaEvet').disabled = !e.target.checked));
  $('#sifirlaVazgec').addEventListener('click', () => dlg.close());
  $('#sifirlaEvet').addEventListener('click', async () => {
    $('#sifirlaEvet').disabled = $('#sifirlaVazgec').disabled = $('#sifirlaOnay').disabled = true;
    $('#sifirlaDurum').textContent = 'Sıfırlanıyor… emülatörler kapatılıyor, dosyalar siliniyor (1 dakikayı bulabilir).';
    try {
      const r = await api('POST', '/api/sifirla', { onay: 'SIFIRLA' });
      $('#sifirlaDurum').textContent = `Tamamlandı. Silinen sanal cihaz: ${r.silinen.length}. Panel yenileniyor…`;
      setTimeout(() => location.reload(), 1500);
    } catch (err) {
      $('#sifirlaDurum').textContent = `Hata: ${err.message}`;
      $('#sifirlaVazgec').disabled = $('#sifirlaOnay').disabled = false;
    }
  });
  $('#proxyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('POST', '/api/proxies', { name: f.pname.value.trim(), url: f.purl.value.trim(), tz: f.ptz.value.trim() || undefined });
      f.reset();
      f.hidden = true;
      toast('Ağ çıkışı kaydedildi');
      loadProxies();
    } catch (err) {
      fail(err);
    }
  });
  $('#lamps').replaceChildren(h('span', { class: 'lamp' }, 'Denetleniyor…'));
  loadSecurity();
  setInterval(loadSecurity, 300000); // 5 dk: sık denetim anlık yük yaratıyordu

  let avdTimer;
  const es = new EventSource('/api/events');
  es.addEventListener('kayitAdim', () => {
    if (!S.rec || S.rec.stopped) return;
    S.rec.cihaz = (S.rec.cihaz || 0) + 1;
    recSay();
  });
  es.addEventListener('devices', (e) => {
    const d = JSON.parse(e.data);
    const before = S.devices.map((x) => x.serial + x.state).join();
    S.devices = d.devices;
    S.hidden = d.hidden;
    S.adbError = d.adbError;
    onDevices();
    if (before !== S.devices.map((x) => x.serial + x.state).join()) {
      clearTimeout(avdTimer);
      avdTimer = setTimeout(() => (loadAvds(), loadAccount(), loadSecurity()), 800);
    }
  });
  es.addEventListener('audit', (e) => addAudit(JSON.parse(e.data)));
  es.addEventListener('sifirlandi', () => setTimeout(() => location.reload(), 1500));
  es.addEventListener('sablon', (e) => {
    const el = $('#sablonDurum');
    if (el) el.textContent = JSON.parse(e.data).mesaj;
  });
  es.addEventListener('playkur', (e) => {
    const p = JSON.parse(e.data);
    const msg = `${labelOf(p.serial)} · ${p.pkg}: ${p.mesaj}`;
    $('#playDurum').textContent = msg;
    if (p.bitti || p.hata) toast(msg, !!p.hata);
    if (p.bitti && S.tab === 'uygulama') loadApps(true);
  });
  es.addEventListener('bellek', (e) => toast(JSON.parse(e.data).msg, true));
  es.addEventListener('kuyruk', (e) => {
    const { sirada } = JSON.parse(e.data);
    if (sirada.length > 1) toast(`Sıralı açılış: ${sirada[0]} açılıyor, sırada ${sirada.length - 1} cihaz (makine boğulmasın diye)`);
  });
  es.addEventListener('sdk', (e) => {
    const p = JSON.parse(e.data);
    const bar = $('#sdkProg span');
    if (bar) bar.style.width = p.total ? `${Math.round((p.done / p.total) * 100)}%` : '0%';
    const msg = $('#sdkMsg');
    if (msg) msg.textContent = p.total ? `${p.label}: ${Math.round(p.done / 1048576)} / ${Math.round(p.total / 1048576)} MB` : p.label;
    if (p.finished || p.error) {
      if (p.error) toast(p.label, true);
      else toast('Emülatör bileşenleri kuruldu');
      loadSdk();
      loadAvds();
    }
  });
  es.addEventListener('job', (e) => {
    const j = JSON.parse(e.data);
    S.jobs.set(j.id, j);
    if (S.tab === 'makro') renderJobs();
    if (j.state === 'done') toast(`Makro bitti: ${j.name}`);
  });
}

init().catch(fail);
