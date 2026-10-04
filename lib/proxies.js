// Emülatör ağ çıkışları (VPN sağlayıcısının HTTP proxy uçları). Yalnızca bu bilgisayarda saklanır;
// şifreler arayüze ve kayıt defterine asla gitmez.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { HttpError } from './util.js';

const NAME_RE = /^[\p{L}\p{N} ._()-]{1,40}$/u;
const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z_+-]+){1,2}$/;

export class Proxies {
  constructor(file) {
    this.file = file;
  }

  all() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return [];
    }
  }

  save(list) {
    fs.writeFileSync(this.file, JSON.stringify(list, null, 1), { mode: 0o600 });
  }

  // Arayüze giden hali: şifre gizli
  list() {
    return this.all().map((p) => ({ id: p.id, name: p.name, tz: p.tz || null, url: mask(p.url) }));
  }

  get(id) {
    const p = this.all().find((x) => x.id === id);
    if (!p) throw new HttpError(404, 'Ağ çıkışı bulunamadı');
    return p;
  }

  add({ name, url, tz }) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new HttpError(400, 'Ad: harf, rakam, boşluk ( ) . _ - (en çok 40)');
    const u = parse(url);
    if (tz != null && tz !== '' && (typeof tz !== 'string' || !TZ_RE.test(tz))) throw new HttpError(400, 'Saat dilimi örn. Europe/Berlin biçiminde olmalı');
    const list = this.all();
    if (list.length >= 100) throw new HttpError(400, 'En çok 100 ağ çıkışı');
    const p = { id: crypto.randomUUID(), name, url: u, tz: tz || null };
    list.push(p);
    this.save(list);
    return { id: p.id, name, url: mask(u), tz: p.tz };
  }

  remove(id) {
    this.save(this.all().filter((p) => p.id !== id));
  }
}

function parse(url) {
  if (typeof url !== 'string' || url.length > 500) throw new HttpError(400, 'Geçersiz proxy adresi');
  let u;
  try {
    u = new URL(url.includes('://') ? url : `http://${url}`);
  } catch {
    throw new HttpError(400, 'Geçersiz proxy adresi (örn. http://kullanici:sifre@sunucu:8080)');
  }
  if (u.protocol !== 'http:') throw new HttpError(400, 'Emülatör yalnızca HTTP proxy destekler (http://…)');
  if (!u.hostname || !u.port) throw new HttpError(400, 'Sunucu ve port gerekli (örn. sunucu.vpn.com:8080)');
  if (u.pathname !== '/' || u.search || u.hash) throw new HttpError(400, 'Proxy adresinde yol/parametre olmamalı');
  return `http://${u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : ''}${u.host}`;
}

function mask(url) {
  const u = new URL(url);
  return `http://${u.username ? `${decodeURIComponent(u.username)}:***@` : ''}${u.host}`;
}
