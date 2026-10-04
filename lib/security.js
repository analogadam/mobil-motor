import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, adb, shellRaw } from './adb.js';

const isLocal = (addr) => addr.startsWith('127.') || addr.startsWith('[::1]');
let fwCache = null;

async function listeners() {
  const out = await run('netstat', ['-ano', '-p', 'TCP'], { timeout: 10000 }).catch(() => '');
  const v6 = await run('netstat', ['-ano', '-p', 'TCPv6'], { timeout: 10000 }).catch(() => '');
  return (out + '\n' + v6)
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[0] === 'TCP' && p[3] === 'LISTENING')
    .map((p) => {
      const i = p[1].lastIndexOf(':');
      return { addr: p[1].slice(0, i), port: Number(p[1].slice(i + 1)) };
    });
}

// Her kontrol: ok / warn / bad + açıklama + (varsa) tek tıkla düzeltme
export async function check(hub, port) {
  const checks = [];
  const L = await listeners();

  const panel = L.filter((l) => l.port === port);
  checks.push({
    id: 'panel',
    level: panel.length && panel.every((l) => isLocal(l.addr)) ? 'ok' : 'bad',
    title: 'Panel yalnızca bu bilgisayara açık',
    detail: panel.length ? panel.map((l) => `${l.addr}:${l.port}`).join(', ') : 'dinleyici bulunamadı',
  });

  const adbL = L.filter((l) => l.port === 5037);
  checks.push({
    id: 'adb',
    level: adbL.every((l) => isLocal(l.addr)) ? 'ok' : 'bad',
    title: 'adb sunucusu dışarıya kapalı',
    detail: adbL.length ? adbL.map((l) => `${l.addr}:${l.port}`).join(', ') : 'adb çalışmıyor',
  });

  const emuL = L.filter((l) => l.port >= 5554 && l.port <= 5685);
  if (emuL.length) {
    checks.push({
      id: 'emu-ports',
      level: emuL.every((l) => isLocal(l.addr)) ? 'ok' : 'bad',
      title: 'Emülatör portları dışarıya kapalı',
      detail: [...new Set(emuL.map((l) => `${l.addr}:${l.port}`))].join(', '),
    });
  }

  for (const d of hub.devices.values()) {
    if (d.transport === 'network') {
      checks.push({
        id: `net:${d.serial}`,
        level: 'warn',
        title: `${hub.label(d.serial)} Wi-Fi üzerinden bağlı`,
        detail: 'Ağdaki trafik adb ile şifresiz gider. USB tercih et.',
        fix: { id: 'disconnect', serial: d.serial, label: 'Bağlantıyı kes' },
      });
    }
    if (d.state === 'device' && d.transport === 'usb') {
      const out = await shellRaw(d.serial, 'getprop service.adb.tcp.port; echo @@; settings get global adb_wifi_enabled', { timeout: 8000 }).catch(() => '');
      const [tcp, wifi] = out.split('@@').map((s) => s.trim());
      const tcpOn = Number(tcp) > 0;
      const wifiOn = wifi === '1';
      checks.push({
        id: `wifi:${d.serial}`,
        level: tcpOn || wifiOn ? 'warn' : 'ok',
        title: `${hub.label(d.serial)}: kablosuz hata ayıklama ${tcpOn || wifiOn ? 'AÇIK' : 'kapalı'}`,
        detail: tcpOn
          ? `Telefon ağdan ${tcp} portunda adb bağlantısı kabul ediyor.`
          : wifiOn
            ? 'Kablosuz hata ayıklama açık (eşleşmiş cihazlar bağlanabilir).'
            : 'Telefona yalnızca USB kablosuyla erişilebiliyor.',
        fix: tcpOn || wifiOn ? { id: 'usb-only', serial: d.serial, label: 'Kapat, yalnızca USB' } : undefined,
      });
    }
    if (d.state === 'unauthorized') {
      checks.push({
        id: `auth:${d.serial}`,
        level: 'warn',
        title: `${d.serial} izin bekliyor`,
        detail: 'Telefonda çıkan "USB hata ayıklamaya izin ver" penceresini onayla. Parmak izini tanıyorsan onayla.',
      });
    }
  }

  let optedIn = null;
  try {
    optedIn = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.android', 'analytics.settings'), 'utf8')).hasOptedIn;
  } catch {}
  checks.push({
    id: 'metrics',
    level: optedIn === true ? 'warn' : 'ok',
    title: 'Android SDK Google\'a kullanım verisi göndermiyor',
    detail: optedIn === true ? 'Android Studio > Settings > Data Sharing kapat.' : 'Emülatörler ayrıca telemetri ve çökme raporu kapalı açılıyor.',
  });

  const reg = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Clipboard', '/v', 'EnableCloudClipboard'], { timeout: 5000 }).catch(() => '');
  const cloud = /EnableCloudClipboard\s+REG_DWORD\s+0x1/.test(reg);
  checks.push({
    id: 'clipboard',
    level: cloud ? 'warn' : 'ok',
    title: `Windows bulut panosu ${cloud ? 'AÇIK' : 'kapalı'}`,
    detail: cloud
      ? 'Kopyaladığın her şey Microsoft hesabına senkronlanabilir. Ayarlar > Sistem > Pano > "Cihazlar arasında paylaş" kapat.'
      : 'Panoya kopyalananlar bu bilgisayarda kalıyor. scrcpy pano senkronu da kapalı.',
  });

  // Güvenlik duvarında bu araçlara "içeri izin ver" kuralı var mı? (ikinci savunma hattı)
  // PowerShell ağır: sonuç 10 dk önbellekte (sık denetim anlık işlemci yükü yaratıyordu)
  if (!fwCache || Date.now() - fwCache.at > 10 * 60000) {
    const out = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-NetFirewallApplicationFilter | Where-Object { $_.Program -match 'adb|qemu|netsimd|emulator|scrcpy|nodejs' } | ForEach-Object { $r = $_ | Get-NetFirewallRule; if ($r.Enabled -eq 'True' -and $r.Direction -eq 'Inbound' -and $r.Action -eq 'Allow') { Split-Path $_.Program -Leaf } } | Sort-Object -Unique",
      ],
      { timeout: 20000 }
    ).catch(() => null);
    fwCache = { at: Date.now(), out };
  }
  const fw = fwCache.out;
  if (fw !== null) {
    const progs = fw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    checks.push({
      id: 'firewall',
      level: progs.length ? 'warn' : 'ok',
      title: progs.length ? `Güvenlik duvarı ${progs.join(', ')} için içeri izin veriyor` : 'Güvenlik duvarı bu araçlara içeriden erişimi engelliyor',
      detail: progs.length
        ? 'Şu an hepsi yalnızca 127.0.0.1 dinlediği için açık yok, ama ikinci savunma hattı için bu kuralları kaldır: Windows Güvenlik › Güvenlik duvarı › Gelişmiş ayarlar › Gelen kuralları.'
        : 'Ağdan gelen bağlantılar adb, emülatör ve Node için engelli.',
    });
  }

  checks.push({
    id: 'outbound',
    level: 'ok',
    title: 'Panel kendi başına internete bağlanmaz',
    detail: 'Tek istisna: sen "Emülatör bileşenlerini indir" dersen yalnızca dl.google.com (HTTPS, SHA-1 doğrulamalı). Arayüz dış kaynak yüklemez, CSP ile engelli.',
  });

  return checks;
}

export async function fix(hub, id, serial) {
  if (id === 'disconnect') {
    const d = hub.devices.get(serial);
    if (!d || d.transport !== 'network') throw new Error('Ağ cihazı değil');
    return adb(['disconnect', serial], { timeout: 10000 });
  }
  if (id === 'usb-only') {
    hub.require(serial);
    await shellRaw(serial, 'settings put global adb_wifi_enabled 0', { timeout: 8000 }).catch(() => '');
    // service.adb.tcp.port açıksa adbd'yi USB moduna döndür (bağlantı kısa süre kopar)
    const tcp = (await shellRaw(serial, 'getprop service.adb.tcp.port', { timeout: 8000 }).catch(() => '')).trim();
    if (Number(tcp) > 0) await adb(['-s', serial, 'usb'], { timeout: 10000 });
    return 'ok';
  }
  throw new Error('Bilinmeyen düzeltme');
}
