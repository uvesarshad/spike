/* Cross-platform "run `spike daemon` on login as a background service" installer.
 *
 * This is the desktop half of the one-line-installer UX: the install script (or a
 * power user) runs `spike daemon --install-service`, and from then on the daemon
 * auto-starts on login and the extension's connection dot goes green with no
 * terminal. Uninstall with `spike daemon --uninstall-service`.
 *
 * Per platform we register the OS-native "run this on login" mechanism, pointing
 * at the SAME node + cli.js that invoked us (so a global npm install, an nvm
 * node, or a packaged binary all resolve correctly):
 *   - Windows : a Scheduled Task (schtasks) with an ONLOGON trigger.
 *   - macOS   : a per-user LaunchAgent plist under ~/Library/LaunchAgents.
 *   - Linux   : a systemd --user unit (falls back to a clear message if systemd
 *               user units aren't available — e.g. inside a bare container).
 *
 * We never require elevation: everything is per-user. The TLS-intercepting-
 * antivirus/corporate-proxy workaround (NODE_OPTIONS=--use-system-ca — needed
 * behind AVG, Zscaler, and similar TLS-MITM setups) is baked into the service
 * env by default so the daemon's own CLI child calls don't hit OAuth/TLS exit
 * 41 (see CLAUDE.md). A36 (P1): set SPIKE_NO_SYSTEM_CA=1 before running
 * --install-service to omit it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** All external-command spawns route through this indirection so tests can stub
 * it (via `__setRunner`) and assert the exact args without touching the OS. */
let runner: (file: string, args: string[]) => void =
  (file, args) => { execFileSync(file, args, { stdio: 'pipe' }); };

/** Test-only: replace the command runner. Returns the previous runner. */
export function __setRunner(fn: (file: string, args: string[]) => void): (file: string, args: string[]) => void {
  const prev = runner;
  runner = fn;
  return prev;
}

/** Run an external command, throwing on failure (mirrors execFileSync). */
function run(file: string, args: string[]): void {
  runner(file, args);
}

/** Stable identifiers for the registered service across platforms. */
const SERVICE_ID = 'com.spike-agent.daemon';
const TASK_NAME = 'Spike Core'; // Windows Scheduled Task display name

export interface InstallServiceOptions {
  /** Bridge port the daemon listens on; embedded into the service command. */
  bridgePort: number;
  /** Extra env baked into the service (merged over the system-CA default; see serviceEnv()). */
  env?: Record<string, string>;
}

export interface ServiceResult {
  ok: boolean;
  platform: NodeJS.Platform;
  /** Human-readable detail for the CLI to print. */
  message: string;
  /** The file we wrote (plist / unit), when applicable. */
  path?: string;
}

/** Absolute path to the node binary and the cli.js entry that launched us, so the
 * service re-invokes the exact same runtime. Resolves symlinks for stability. */
function resolveSelf(): { node: string; cli: string } {
  const node = process.execPath;
  // argv[1] is the cli.js entry (dist/cli.js when built). Fall back to argv[1] raw.
  let cli = process.argv[1] || '';
  try { cli = fs.realpathSync(cli); } catch { /* keep raw */ }
  return { node, cli };
}

/** The env every platform bakes in: the TLS-intercepting-AV/proxy fix (unless
 * opted out via SPIKE_NO_SYSTEM_CA), plus any caller extras. */
function serviceEnv(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  // A36 (P1): honor SPIKE_NO_SYSTEM_CA=1 to omit the flag entirely. Otherwise
  // prefer the system CA store so a TLS-intercepting antivirus or corporate
  // proxy (AVG, Zscaler, …) doesn't break the daemon's OAuth calls — harmless
  // on machines that don't need it.
  if (process.env.SPIKE_NO_SYSTEM_CA !== '1' && process.env.SPIKE_NO_SYSTEM_CA !== 'true') {
    base.NODE_OPTIONS = '--use-system-ca';
  }
  return {
    ...base,
    ...(extra || {}),
  };
}

// ---------------------------------------------------------------------------
// Windows — Scheduled Task via schtasks
// ---------------------------------------------------------------------------

/** schtasks has no dedicated env-var flag, so the standard workaround is to
 * chain `cmd /c set "K=V"&& ...` ahead of the real command — each entry sets
 * one var in the same cmd.exe invocation that then execs node. Values are
 * quoted; one containing `"` or a newline would break out of that quoting
 * (and could inject extra commands), so such values are rejected outright
 * rather than silently mis-escaped. */
function cmdEnvPrefix(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => {
      if (/["\r\n]/.test(k) || /["\r\n]/.test(v)) {
        throw new Error(`serviceEnv value for "${k}" contains a quote or newline, unsafe to embed in a Scheduled Task command line`);
      }
      return `set "${k}=${v}"&&`;
    })
    .join(' ');
}

function installWindows(opts: InstallServiceOptions): ServiceResult {
  const { node, cli } = resolveSelf();
  // schtasks /TR must be a single string; quote the exe + args. The task runs
  // `cmd /c set ...&& node cli.js daemon --bridge-port <n>` at logon of the
  // current user, with the env prefix baking in serviceEnv() (NODE_OPTIONS=
  // --use-system-ca, unless SPIKE_NO_SYSTEM_CA=1) the same way
  // installMac()/installLinux() already do.
  const envPrefix = cmdEnvPrefix(serviceEnv(opts.env));
  const tr = `cmd /c ${envPrefix} "${node}" "${cli}" daemon --bridge-port ${opts.bridgePort}`;
  // Scope the task to THIS user (/RU) so the ONLOGON trigger doesn't need the
  // machine-level "log on as batch/logon-trigger" right that a non-elevated
  // shell lacks — that's the "Access is denied" you get without /RU.
  const runAs = `${os.userInfo().username}`;
  const baseArgs = ['/Create', '/TN', TASK_NAME, '/TR', tr, '/SC', 'ONLOGON', '/RU', runAs, '/F'];
  try {
    // /F overwrites an existing task of the same name (idempotent re-install).
    run('schtasks', baseArgs);
    // Start it now so the user doesn't have to log out/in first.
    try { run('schtasks', ['/Run', '/TN', TASK_NAME]); } catch { /* non-fatal */ }
    return {
      ok: true,
      platform: 'win32',
      message:
        `Registered Scheduled Task "${TASK_NAME}" (runs on logon) and started it now.\n` +
        `The daemon will auto-start every login. Uninstall: spike daemon --uninstall-service`,
    };
  } catch (e) {
    return {
      ok: false,
      platform: 'win32',
      message: `Could not register the Scheduled Task: ${errMsg(e)}\n` +
        `You can still run the daemon manually: spike daemon`,
    };
  }
}

function uninstallWindows(): ServiceResult {
  try {
    run('schtasks', ['/End', '/TN', TASK_NAME]);
  } catch { /* task may not be running */ }
  try {
    run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
    return { ok: true, platform: 'win32', message: `Removed Scheduled Task "${TASK_NAME}".` };
  } catch (e) {
    return { ok: false, platform: 'win32', message: `Could not remove the task: ${errMsg(e)}` };
  }
}

// ---------------------------------------------------------------------------
// macOS — LaunchAgent plist
// ---------------------------------------------------------------------------

function launchAgentPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_ID}.plist`);
}

function installMac(opts: InstallServiceOptions): ServiceResult {
  const { node, cli } = resolveSelf();
  const env = serviceEnv(opts.env);
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(cli)}</string>
    <string>daemon</string>
    <string>--bridge-port</string>
    <string>${opts.bridgePort}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
  const dest = launchAgentPath();
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, plist, 'utf8');
    // (re)load it. `bootout` first to make re-install idempotent, ignoring errors.
    const uid = process.getuid ? process.getuid() : 0;
    const domain = `gui/${uid}`;
    try { run('launchctl', ['bootout', `${domain}/${SERVICE_ID}`]); } catch { /* not loaded */ }
    run('launchctl', ['bootstrap', domain, dest]);
    try { run('launchctl', ['enable', `${domain}/${SERVICE_ID}`]); } catch { /* best-effort */ }
    return {
      ok: true,
      platform: 'darwin',
      path: dest,
      message:
        `Installed LaunchAgent → ${dest}\n` +
        `The daemon will auto-start on login (and is running now). Uninstall: spike daemon --uninstall-service`,
    };
  } catch (e) {
    return {
      ok: false,
      platform: 'darwin',
      path: dest,
      message: `Could not install the LaunchAgent: ${errMsg(e)}\n` +
        `You can still run the daemon manually: spike daemon`,
    };
  }
}

function uninstallMac(): ServiceResult {
  const dest = launchAgentPath();
  const uid = process.getuid ? process.getuid() : 0;
  try { run('launchctl', ['bootout', `gui/${uid}/${SERVICE_ID}`]); } catch { /* not loaded */ }
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    return { ok: true, platform: 'darwin', path: dest, message: `Removed LaunchAgent ${dest}.` };
  } catch (e) {
    return { ok: false, platform: 'darwin', path: dest, message: `Could not remove the LaunchAgent: ${errMsg(e)}` };
  }
}

// ---------------------------------------------------------------------------
// Linux — systemd --user unit
// ---------------------------------------------------------------------------

function systemdUnitPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'systemd', 'user', 'spike-core.service');
}

function installLinux(opts: InstallServiceOptions): ServiceResult {
  const { node, cli } = resolveSelf();
  const env = serviceEnv(opts.env);
  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment=${systemdEscape(k)}=${systemdEscape(v)}`)
    .join('\n');
  const unit = `[Unit]
Description=Spike Core (Spike extension bridge daemon)
After=network.target

[Service]
Type=simple
ExecStart=${node} ${cli} daemon --bridge-port ${opts.bridgePort}
${envLines}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
  const dest = systemdUnitPath();
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, unit, 'utf8');
    // Requires a user systemd instance (most desktop Linux). Fails clearly in
    // containers/minimal hosts — we surface that rather than pretending success.
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'spike-core.service']);
    return {
      ok: true,
      platform: 'linux',
      path: dest,
      message:
        `Installed systemd --user unit → ${dest}\n` +
        `Enabled + started. It auto-starts on login (you may need: loginctl enable-linger $USER).\n` +
        `Uninstall: spike daemon --uninstall-service`,
    };
  } catch (e) {
    return {
      ok: false,
      platform: 'linux',
      path: dest,
      message:
        `Wrote ${dest} but could not enable it via systemctl --user: ${errMsg(e)}\n` +
        `If this host has no user systemd, just run the daemon manually: spike daemon`,
    };
  }
}

function uninstallLinux(): ServiceResult {
  const dest = systemdUnitPath();
  try { run('systemctl', ['--user', 'disable', '--now', 'spike-core.service']); } catch { /* not enabled */ }
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    try { run('systemctl', ['--user', 'daemon-reload']); } catch { /* best-effort */ }
    return { ok: true, platform: 'linux', path: dest, message: `Removed systemd unit ${dest}.` };
  } catch (e) {
    return { ok: false, platform: 'linux', path: dest, message: `Could not remove the systemd unit: ${errMsg(e)}` };
  }
}

// ---------------------------------------------------------------------------
// public entry points
// ---------------------------------------------------------------------------

/** Register `spike daemon` to auto-start on login for the current user. */
export function installService(opts: InstallServiceOptions): ServiceResult {
  switch (process.platform) {
    case 'win32':  return installWindows(opts);
    case 'darwin': return installMac(opts);
    case 'linux':  return installLinux(opts);
    default:
      return {
        ok: false,
        platform: process.platform,
        message: `Auto-start service is not supported on ${process.platform}. Run the daemon manually: spike daemon`,
      };
  }
}

/** Remove the registered auto-start service for the current user. */
export function uninstallService(): ServiceResult {
  switch (process.platform) {
    case 'win32':  return uninstallWindows();
    case 'darwin': return uninstallMac();
    case 'linux':  return uninstallLinux();
    default:
      return { ok: false, platform: process.platform, message: `Nothing to uninstall on ${process.platform}.` };
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Guard a key/value before it's interpolated into a systemd unit file line
 * (`Environment=${k}=${v}`). A newline would start a new unit-file line —
 * letting a value inject arbitrary directives (e.g. a second `ExecStart=`) —
 * so reject rather than strip, the same "unsafe to embed, refuse" stance as
 * cmdEnvPrefix() takes for the Windows side. Unreachable today (only a
 * parseInt'd port flows through `env`), hardening for if that ever changes. */
function systemdEscape(s: string): string {
  if (/[\r\n]/.test(s)) {
    throw new Error(`serviceEnv value "${s}" contains a newline, unsafe to embed in a systemd unit file`);
  }
  return s;
}
