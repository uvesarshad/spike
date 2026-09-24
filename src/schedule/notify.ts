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

export type WebhookKind = 'slack' | 'discord' | 'generic';

/** Which chat service a webhook address belongs to (by host/path), else generic. */
export function webhookKind(url: string): WebhookKind {
  try {
    const u = new URL(url);
    if (u.hostname === 'hooks.slack.com' || (u.hostname.endsWith('.slack.com') && u.pathname.startsWith('/services/'))) return 'slack';
    if (/(^|\.)(discord|discordapp)\.com$/.test(u.hostname) && u.pathname.startsWith('/api/webhooks/')) return 'discord';
  } catch { /* not a URL: treat as generic */ }
  return 'generic';
}

/** The JSON body to POST for this webhook. Slack and Discord get a readable
 * message; anything else gets the raw status-change object (unchanged). */
export function webhookPayload(url: string, c: StatusChange): unknown {
  const kind = webhookKind(url);
  if (kind === 'generic') return c;
  const failing = c.verdict === 'fail';
  const { title, body } = notifyMessage(c);
  const link = c.runId ? `\nRun: ${c.runId}` : '';
  if (kind === 'slack') {
    return {
      text: `${title}: ${c.job}`,
      attachments: [{ color: failing ? '#d93025' : '#188038', text: `${body}\n${c.url}${link}`.slice(0, 2900) }],
    };
  }
  return {
    content: title,
    embeds: [{ title: c.job.slice(0, 250), description: `${c.summary}\n${c.url}${link}`.slice(0, 3900), color: failing ? 0xd93025 : 0x188038 }],
  };
}

/** A pull-request run result as a status change, for `spike ci --webhook`. */
export function ciStatusChange(r: { url: string; verdict: Verdict; error?: string; suite?: { summary: string }; check?: { summary: string } }): StatusChange {
  const summary = r.error ?? [r.suite?.summary, r.check?.summary].filter(Boolean).join(' ');
  return { job: 'ci', verdict: r.verdict, url: r.url, summary: summary || r.verdict };
}

/** POST a status change to a webhook in the right shape. Never throws. */
export async function postWebhook(webhook: string, change: StatusChange, fetchFn?: NotifyDeps['fetchFn']): Promise<void> {
  try {
    const f = fetchFn ?? ((u: string, i: { method: string; headers: Record<string, string>; body: string }) => fetch(u, i));
    await f(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(webhookPayload(webhook, change)) });
  } catch { /* a dead webhook must not break the run loop */ }
}

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
  if (webhook) await postWebhook(webhook, change, deps.fetchFn);
  return true;
}
