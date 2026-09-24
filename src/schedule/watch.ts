/* A7 — `spike watch`: re-run on change. The controller is pure (timers and the
 * run function injected): a burst of events becomes one run after the debounce;
 * a change during a run queues exactly one follow-up. */

import fs from 'node:fs';
import path from 'node:path';

export const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'build', 'artifacts'];

export function shouldIgnore(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return parts.some((p) => IGNORED_DIRS.includes(p) || p.startsWith('.spike'));
}

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export interface WatchDeps {
  run: () => Promise<void>;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export class WatchController {
  private timer: unknown = null;
  private running = false;
  private queued = false;
  runs = 0;
  private done: Array<() => void> = [];
  constructor(private deps: WatchDeps) {}

  event(): void {
    const set = this.deps.setTimer ?? ((f, ms) => setTimeout(f, ms));
    const clear = this.deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    if (this.timer !== null) clear(this.timer);
    this.timer = set(() => { this.timer = null; void this.fire(); }, this.deps.debounceMs ?? 3000);
  }

  private async fire(): Promise<void> {
    if (this.running) { this.queued = true; return; }
    this.running = true;
    try {
      do {
        this.queued = false;
        this.runs++;
        try { await this.deps.run(); } catch { /* the caller reports failures */ }
      } while (this.queued);
    } finally {
      this.running = false;
      for (const d of this.done.splice(0)) d();
    }
  }

  /** Resolves when nothing is running (test helper). */
  idle(): Promise<void> {
    return this.running ? new Promise((r) => this.done.push(r)) : Promise.resolve();
  }
}

export interface FsWatchOptions {
  root: string;
  on: 'save' | 'commit';
  paths?: string;
  onChange: () => void;
}

/** Real recursive fs watch feeding onChange. Returns a stop function. */
export function startFsWatch(o: FsWatchOptions): () => void {
  const glob = o.paths ? globToRegex(o.paths) : null;
  const base = o.on === 'commit' ? path.join(o.root, '.git') : o.root;
  const w = fs.watch(base, { recursive: true }, (_ev, file) => {
    if (!file) return;
    const rel = String(file).replace(/\\/g, '/');
    if (o.on === 'commit') {
      if (rel === 'HEAD' || rel.startsWith('refs/')) o.onChange();
      return;
    }
    if (shouldIgnore(rel)) return;
    if (glob && !glob.test(rel)) return;
    o.onChange();
  });
  return () => w.close();
}
