import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { validate, execute } from './actions.js';
import { HttpError, sleep } from './util.js';

export const MACRO_RE = /^[\p{L}\p{N} _-]{1,40}$/u;

export class Macros {
  constructor(dir) {
    this.dir = dir;
  }

  file(name) {
    if (typeof name !== 'string' || !MACRO_RE.test(name)) throw new HttpError(400, 'Makro adı: harf, rakam, boşluk, _ - (en çok 40)');
    return path.join(this.dir, `${name.normalize('NFC')}.json`);
  }

  async list() {
    const files = await fsp.readdir(this.dir).catch(() => []);
    const out = [];
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      try {
        const m = JSON.parse(await fsp.readFile(path.join(this.dir, f), 'utf8'));
        out.push({ name: m.name, steps: m.steps.length, created: m.created, duration: m.steps.reduce((s, x) => s + (x.delay || 0) + (x.ms || 0), 0) });
      } catch {}
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  }

  async load(name) {
    try {
      const m = JSON.parse(await fsp.readFile(this.file(name), 'utf8'));
      return { ...m, steps: m.steps.map(validate) };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(404, 'Makro bulunamadı');
    }
  }

  async save(name, steps) {
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > 5000) throw new HttpError(400, 'Makro adımları geçersiz');
    const clean = steps.map(validate);
    await fsp.writeFile(this.file(name), JSON.stringify({ name, created: new Date().toISOString(), steps: clean }, null, 1));
  }

  async remove(name) {
    await fsp.rm(this.file(name), { force: true });
  }
}

// Makroyu birden çok cihazda paralel oynatan görevler
export class Jobs extends EventEmitter {
  constructor(hub, audit) {
    super();
    this.hub = hub;
    this.audit = audit;
    this.jobs = new Map();
  }

  list() {
    return [...this.jobs.values()].map((j) => this.view(j));
  }

  view(j) {
    return { id: j.id, name: j.name, targets: j.targets, repeat: j.repeat, state: j.state, progress: j.progress, total: j.total, errors: j.errors };
  }

  start(macro, targets, repeat) {
    const j = {
      id: crypto.randomUUID(),
      name: macro.name,
      targets: targets.map((d) => d.serial),
      repeat,
      total: macro.steps.length * repeat,
      progress: {},
      errors: {},
      state: 'running',
      cancel: false,
    };
    this.jobs.set(j.id, j);
    this.emit('job', this.view(j));
    const wait = async (ms) => {
      const end = Date.now() + ms;
      while (!j.cancel && Date.now() < end) await sleep(Math.min(200, end - Date.now()));
    };
    Promise.all(
      j.targets.map(async (serial) => {
        let done = 0;
        try {
          for (let r = 0; r < repeat; r++) {
            for (const step of macro.steps) {
              if (j.cancel) return;
              if (step.delay) await wait(step.delay);
              if (j.cancel) return;
              if (step.type === 'wait') await wait(step.ms);
              else await execute(this.hub, serial, step);
              j.progress[serial] = ++done;
              this.emit('job', this.view(j));
            }
          }
        } catch (e) {
          j.errors[serial] = e.stderr || e.message;
        }
      })
    ).then(() => {
      j.state = j.cancel ? 'stopped' : Object.keys(j.errors).length ? 'error' : 'done';
      this.audit.log('makro bitti', j.targets, `${j.name} → ${j.state}`, j.state === 'done');
      this.emit('job', this.view(j));
      setTimeout(() => this.jobs.delete(j.id), 10 * 60 * 1000);
    });
    return this.view(j);
  }

  stop(id) {
    const j = this.jobs.get(id);
    if (!j) throw new HttpError(404, 'Görev yok');
    j.cancel = true;
  }
}
