export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Dosya adı olarak güvenle kullanılabilecek hale getirir (yol ayırıcı, nokta ile başlama vb. yok)
export function safeName(s, max = 80) {
  const out = String(s ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, max);
  return out || 'dosya';
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
