// Emülatör bileşenlerini (emülatör + Play Store'lu Android imajı) Google'ın resmî deposundan kurar.
// YALNIZCA kullanıcı "indir" dediğinde çalışır; yalnızca https://dl.google.com; her dosya
// Google'ın yayımladığı SHA-1 ile doğrulanır, tutmazsa silinir.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { SDK_ROOT, EMULATOR, run, sdkEnv } from './adb.js';
import { systemImages } from './emulator.js';

const REPO = 'https://dl.google.com/android/repository/';
const SYSIMG = 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/';
const API = 35; // test edilmiş Android sürümü (Android 15)

export const progress = new EventEmitter();
let busy = false;

function get(url, onData) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'dl.google.com') return reject(new Error('İzin verilmeyen adres'));
    https
      .get(u, { timeout: 30000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length']) || 0;
        if (onData) onData(res, total);
        else {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }
        res.on('error', reject);
        if (onData) res.on('end', resolve);
      })
      .on('timeout', function () {
        this.destroy(new Error('zaman aşımı'));
      })
      .on('error', reject);
  });
}

async function download(url, dest, sha1, label) {
  const hash = crypto.createHash('sha1');
  const out = fs.createWriteStream(dest);
  let done = 0;
  let last = 0;
  await get(url, (res, total) => {
    res.on('data', (c) => {
      hash.update(c);
      done += c.length;
      if (Date.now() - last > 400) {
        last = Date.now();
        progress.emit('p', { label, done, total });
      }
    });
    res.pipe(out);
  });
  await new Promise((r) => out.close(r));
  const got = hash.digest('hex');
  if (got !== sha1) {
    await fsp.rm(dest, { force: true });
    throw new Error(`${label}: doğrulama tutmadı (SHA-1), dosya silindi`);
  }
}

function findArchive(xml, pathAttr, stableOnly) {
  for (const m of xml.matchAll(/<remotePackage path="([^"]+)">([\s\S]*?)<\/remotePackage>/g)) {
    if (m[1] !== pathAttr) continue;
    if (stableOnly && !/<channelRef ref="channel-0"\/>/.test(m[2])) continue;
    for (const a of m[2].matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
      const body = a[1];
      const os = body.match(/<host-os>(\w+)<\/host-os>/)?.[1];
      if (os && os !== 'windows') continue;
      const sha1 = body.match(/<checksum(?: type="sha1")?>(\w{40})<\/checksum>/)?.[1];
      const url = body.match(/<url>([^<]+)<\/url>/)?.[1];
      if (sha1 && url) return { sha1, url };
    }
  }
  return null;
}

// İndirmeden: hangi dosyaların (boyut + SHA-1) seçileceğini gösterir (test ve şeffaflık için)
export async function plan() {
  const emuXml = await get(REPO + 'repository2-3.xml');
  const imgXml = await get(SYSIMG + 'sys-img2-3.xml');
  const size = (xml, url) => Number(xml.match(new RegExp(`<size>(\\d+)</size>\\s*<checksum[^>]*>\\w+</checksum>\\s*<url>${url.replace(/[.]/g, '\\.')}</url>`))?.[1] || 0);
  const emu = findArchive(emuXml, 'emulator', true);
  const img = findArchive(imgXml, `system-images;android-${API};google_apis_playstore;x86_64`, false);
  return {
    emulator: emu && { url: REPO + emu.url, sha1: emu.sha1, mb: Math.round(size(emuXml, emu.url) / 1048576) },
    image: img && { url: SYSIMG + img.url, sha1: img.sha1, mb: Math.round(size(imgXml, img.url) / 1048576) },
  };
}

export async function status() {
  const images = systemImages();
  let accel = null;
  if (fs.existsSync(EMULATOR)) {
    const out = await run(EMULATOR, ['-accel-check'], { timeout: 20000, env: sdkEnv() }).catch((e) => String(e.stdout || ''));
    accel = { ok: /is installed and usable/i.test(out), detail: out.split(/\r?\n/).find((l) => /WHPX|HAXM|AEHD|accel/i.test(l) && !/^accel:?$/.test(l.trim())) || out.trim().slice(0, 200) };
  }
  return {
    sdk: SDK_ROOT,
    emulator: fs.existsSync(path.join(SDK_ROOT, 'emulator', 'lib', 'pc-bios', 'bios-256k.bin')),
    image: images.some((i) => i.tag.includes('playstore')),
    accel,
    busy,
  };
}

export async function install() {
  if (busy) throw new Error('Kurulum zaten sürüyor');
  busy = true;
  const tmp = path.join(SDK_ROOT, '.mobilmotor-indirme');
  try {
    await fsp.mkdir(tmp, { recursive: true });
    const st = await status();
    if (!st.emulator) {
      progress.emit('p', { label: 'Emülatör listesi alınıyor', done: 0, total: 0 });
      const a = findArchive(await get(REPO + 'repository2-3.xml'), 'emulator', true);
      if (!a) throw new Error('Emülatör paketi bulunamadı');
      const zip = path.join(tmp, 'emulator.zip');
      await download(REPO + a.url, zip, a.sha1, 'Emülatör');
      progress.emit('p', { label: 'Emülatör açılıyor', done: 0, total: 0 });
      await fsp.rm(path.join(SDK_ROOT, 'emulator'), { recursive: true, force: true });
      await run('tar', ['-xf', zip, '-C', SDK_ROOT], { timeout: 600000 });
      await fsp.rm(zip, { force: true });
    }
    if (!st.image) {
      progress.emit('p', { label: 'Android imaj listesi alınıyor', done: 0, total: 0 });
      const a = findArchive(await get(SYSIMG + 'sys-img2-3.xml'), `system-images;android-${API};google_apis_playstore;x86_64`, false);
      if (!a) throw new Error('Android imajı bulunamadı');
      const zip = path.join(tmp, 'image.zip');
      await download(SYSIMG + a.url, zip, a.sha1, `Android ${API - 20} (Play Store)`);
      progress.emit('p', { label: 'Android imajı açılıyor', done: 0, total: 0 });
      const dest = path.join(SDK_ROOT, 'system-images', `android-${API}`, 'google_apis_playstore');
      await fsp.mkdir(dest, { recursive: true });
      await run('tar', ['-xf', zip, '-C', dest], { timeout: 600000 });
      await fsp.rm(zip, { force: true });
    }
    progress.emit('p', { label: 'Tamamlandı', done: 1, total: 1, finished: true });
  } catch (e) {
    progress.emit('p', { label: `Hata: ${e.message}`, error: true });
    throw e;
  } finally {
    busy = false;
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
