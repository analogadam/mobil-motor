// Emülatör süreç önceliği: odaktaki normal, diğerleri (ve açılmakta olanlar) düşük.
// Bilgisayarın geri kalanı (fare, tarayıcı) ve odaktaki cihaz her zaman akıcı kalır.
import os from 'node:os';
import { run } from './adb.js';

const P = os.constants.priority;
const pids = new Map(); // seri → qemu süreç kimliği
const applied = new Map(); // seri → uygulanan öncelik

// emulator-5554 → konsol portu 5554'ü dinleyen süreç = o emülatörün qemu'su
async function pidOf(serial) {
  if (pids.has(serial)) return pids.get(serial);
  const port = Number(serial.split('-')[1]);
  if (!port) return null;
  const out = await run('netstat', ['-ano', '-p', 'TCP'], { timeout: 10000 }).catch(() => '');
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'TCP' && p[1] === `127.0.0.1:${port}` && p[3] === 'LISTENING') {
      pids.set(serial, Number(p[4]));
      return Number(p[4]);
    }
  }
  return null;
}

export async function set(serial, high) {
  const want = high ? P.PRIORITY_NORMAL : P.PRIORITY_BELOW_NORMAL;
  if (applied.get(serial) === want) return;
  const pid = await pidOf(serial);
  if (!pid) return;
  try {
    os.setPriority(pid, want);
    applied.set(serial, want);
  } catch {
    pids.delete(serial); // süreç değişmiş (yeniden açılmış olabilir)
  }
}

export function forget(serial) {
  pids.delete(serial);
  applied.delete(serial);
}
