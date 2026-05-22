import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class JsonFileStore {
  constructor(path, fallback) {
    this.path = path;
    this.fallback = fallback;
  }

  read() {
    try {
      if (!existsSync(this.path)) return structuredClone(this.fallback);
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return structuredClone(this.fallback);
    }
  }

  write(value) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    renameSync(tmp, this.path);
  }
}
