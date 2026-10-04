import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Yerel işlem kaydı: kim/ne zaman/hangi cihaza ne yapıldı. Yalnızca bu bilgisayarda, data/logs altında.
export class Audit extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.recent = [];
  }

  log(action, targets = [], detail = '', ok = true) {
    const entry = { t: new Date().toISOString(), action, targets, detail, ok };
    this.recent.push(entry);
    if (this.recent.length > 300) this.recent.shift();
    const file = path.join(this.dir, `kayit-${entry.t.slice(0, 10)}.log`);
    fs.appendFile(file, JSON.stringify(entry) + '\n', () => {});
    this.emit('entry', entry);
  }
}
