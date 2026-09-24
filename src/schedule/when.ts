/* A7 — the `when` grammar for scheduled tests. Deliberately not cron:
 *   every <N>m | every <N>h | hourly | daily HH:MM | weekdays HH:MM   (local time)
 * Pure: everything takes `now` so tests run on a fake clock. */

export type When =
  | { type: 'interval'; ms: number }
  | { type: 'daily'; hour: number; minute: number; weekdaysOnly: boolean };

const MIN = 60_000;

export function parseWhen(input: string): When {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (s === 'hourly') return { type: 'interval', ms: 60 * MIN };
  let m = /^every (\d+)\s*(m|h)$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n < 1) throw new Error(`"${input}": the number must be at least 1`);
    const ms = n * (m[2] === 'h' ? 60 : 1) * MIN;
    if (ms < 5 * MIN) throw new Error(`"${input}": scheduled tests run at most every 5 minutes`);
    return { type: 'interval', ms };
  }
  m = /^(daily|weekdays) (\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hour = parseInt(m[2], 10);
    const minute = parseInt(m[3], 10);
    if (hour > 23 || minute > 59) throw new Error(`"${input}": that is not a time of day`);
    return { type: 'daily', hour, minute, weekdaysOnly: m[1] === 'weekdays' };
  }
  throw new Error(`I could not read "${input}". Use: every 30m, every 2h, hourly, daily 09:00, or weekdays 09:00 (local time).`);
}

export interface DueJob {
  when: string;
  createdAt: number;
  lastRunAt: number | null;
}

/** The moment a job became (or becomes) due: the first scheduled slot after the
 * last run (or creation). If that is <= now the job is due — and because a run
 * resets lastRunAt to "now", a machine that slept through many slots runs once
 * on wake, never a backlog. */
export function nextDue(job: DueJob, _now: number): number {
  const w = parseWhen(job.when);
  const base = job.lastRunAt ?? job.createdAt;
  if (w.type === 'interval') return base + w.ms;
  const d = new Date(base);
  for (let i = 0; i < 9; i++) {
    const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, w.hour, w.minute, 0, 0);
    if (w.weekdaysOnly && (slot.getDay() === 0 || slot.getDay() === 6)) continue;
    if (slot.getTime() > base) return slot.getTime();
  }
  throw new Error('unreachable: no slot within 9 days');
}

export function isDue(job: DueJob, now: number): boolean {
  return nextDue(job, now) <= now;
}
