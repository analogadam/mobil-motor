import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Kurulum paketiyle gelen / panelden indirilen bileşenler buraya
export const APP_SDK = path.join(APP_ROOT, 'sdk');

const hasAdb = (dir) => !!dir && fs.existsSync(path.join(dir, 'platform-tools', 'adb.exe'));

// Sıra: ANDROID_HOME → Android Studio'nun SDK'sı → MobilMotor'un kendi sdk klasörü
export const SDK_ROOT =
  [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'), APP_SDK].find(hasAdb) || APP_SDK;

export const ADB = path.join(SDK_ROOT, 'platform-tools', 'adb.exe');
export const EMULATOR = path.join(SDK_ROOT, 'emulator', 'emulator.exe');

// Hiçbir yerde kabuk (cmd.exe) kullanılmaz: argümanlar dizi olarak doğrudan programa gider.
export function run(file, args, { timeout = 30000, encoding = 'utf8', maxBuffer = 128 * 1024 * 1024, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, encoding, maxBuffer, windowsHide: true, env }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '').trim();
        err.stdout = stdout;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

export const adb = (args, opts) => run(ADB, args, opts);

// Cihazdaki sh için tek tırnak kaçışı: her argüman tek parça ve yorumlanmadan gider.
export const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

export const shell = (serial, parts, opts) => adb(['-s', serial, 'shell', parts.map(q).join(' ')], opts);

export const shellRaw = (serial, cmd, opts) => adb(['-s', serial, 'shell', cmd], opts);

export const screencap = (serial) =>
  adb(['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 15000 });

// Emülatöre SDK yerini açıkça söyle (SDK standart yerde değilse de bulsun)
export const sdkEnv = (extra = {}) => ({ ...process.env, ANDROID_SDK_ROOT: SDK_ROOT, ANDROID_HOME: SDK_ROOT, ...extra });
