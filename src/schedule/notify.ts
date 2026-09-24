/* A7 — status-change notification. Fires only on pass→fail or fail→pass, never
 * every run. Desktop notification goes through an injectable runner (nothing
 * real is spawned in tests); an optional webhook gets a JSON POST. */

import { execFile } from 'node:child_process';

export type Verdict = 'pass' | 'fail' | 'uncertain';
export type NotifyRunner = (file: string, args: string[]) => void;

export function isStatusFlip(prev: Verdict | null | undefined, next: Verdict): boolean {
  return (prev === 'pass' && next === 'fail') || (prev === 'fail' && next === 'pass');
}

export interface StatusChange {
  job: string;
  verdict: Verdict;
  url: string;
  runId?: string;
  summary: string;
}

export function notifyMessage(c: StatusChange): { title: string; body: string } {
  return {
    title: c.verdict === 'fail' ? 'Spike: a check started failing' : 'Spike: a check is passing again',
    body: `${c.job} — ${c.summary}`.slice(0, 200),
  };
}

/** The command to raise a desktop notification on this OS, or null. */
export function desktopNotifyCommand(platform: NodeJS.Platform, title: string, body: string): { file: string; args: string[] } | null {
  if (platform === 'darwin') {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return { file: 'osascript', args: ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`] };
  }
  if (platform === 'linux') return { file: 'notify-send', args: [title, body] };
  if (platform === 'win32') {
    const q = (s: string) => s.replace(/'/g, "''");
    const script =
      `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; ` +
      `$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); ` +
      `$n = $t.GetElementsByTagName('text'); $n.Item(0).AppendChild($t.CreateTextNode('${q(title)}')) | Out-Null; ` +
      `$n.Item(1).AppendChild($t.CreateTextNode('${q(body)}')) | Out-Null; ` +
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Spike').Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
    return { file: 'powershell', args: ['-NoProfile', '-Command', script] };
  }
  return null;
}

const defaultRunner: NotifyRunner = (file, args) => {
  execFile(file, args, { timeout: 10_000 }, () => { /* unavailable notifier is fine */ });
};

export interface NotifyDeps {
  platform?: NodeJS.Platform;
  runner?: NotifyRunner;
  fetchFn?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>;
  desktop?: boolean;
}

/** Notify only if the verdict flipped. Returns whether it fired. Never throws. */
export async function notifyIfFlipped(prev: Verdict | null | undefined, change: StatusChange, webhook: string | undefined, deps: NotifyDeps = {}): Promise<boolean> {
  if (!isStatusFlip(prev, change.verdict)) return false;
  if (deps.desktop !== false) {
    try {
      const { title, body } = notifyMessage(change);
      const cmd = desktopNotifyCommand(deps.platform ?? process.platform, title, body);
      if (cmd) (deps.runner ?? defaultRunner)(cmd.file, cmd.args);
    } catch { /* silently skipped if unavailable */ }
  }
  if (webhook) {
    try {
      const f = deps.fetchFn ?? ((u: string, i: { method: string; headers: Record<string, string>; body: string }) => fetch(u, i));
      await f(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) });
    } catch { /* a dead webhook must not break the run loop */ }
  }
  return true;
}
