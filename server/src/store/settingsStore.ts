import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Settings } from '../../../shared/types.ts';

export const SettingsSchema = z.strictObject({
  showPromptPreviews: z.boolean(),
});

export const DEFAULT_SETTINGS: Settings = { showPromptPreviews: false };

export class SettingsStore {
  private readonly path: string;
  private value: Settings;

  constructor(path: string) {
    this.path = path;
    this.value = this.load();
  }

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Settings>): Settings {
    const next = SettingsSchema.parse({ ...this.value, ...patch });
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
    this.value = next;
    return next;
  }

  private load(): Settings {
    try {
      const parsed = SettingsSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
}
