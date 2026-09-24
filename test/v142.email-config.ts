/* v142 — A10: email inbox config (`spike config set --email-provider …`) + doctor line.
 * Settings live in a temp LOCALAPPDATA — never the real home. Run: npx tsx test/v142.email-config.ts */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v142-'));
process.env.LOCALAPPDATA = tmp;
delete process.env.SPIKE_EMAIL_PROVIDER; delete process.env.SPIKE_IMAP_HOST; delete process.env.SPIKE_IMAP_USER;
const { SettingsStore } = await import('../src/vibe/settings.js');
const { loadConfig } = await import('../src/config.js');
const { buildDoctorReport, renderDoctorReport } = await import('../src/doctor.js');

const checks: [string, boolean][] = [];
const check = (l: string, ok: boolean) => { checks.push([l, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); };

check('defaults to no inbox', loadConfig().emailProvider === 'none');
new SettingsStore().write({ emailProvider: 'imap', imapHost: 'imap.example.test', imapUser: 'qa@example.test' });
const cfg = loadConfig();
check('config set persists and reaches the run config', cfg.emailProvider === 'imap' && cfg.imapHost === 'imap.example.test' && cfg.imapUser === 'qa@example.test');
check('the password is never in the stored settings', !fs.readFileSync(path.join(tmp, 'spike', 'settings.json'), 'utf8').toLowerCase().includes('pass'));

const base = { chrome: { path: '/x' }, nano: { availability: 'available' }, roles: [], run: { readOnly: false, via: 'cdp', allowedHosts: [], strictOracles: true } };
const line = (email: never) => renderDoctorReport(buildDoctorReport({ ...base, email })).find((l) => l.includes('Email codes')) ?? '';
check('doctor: off', line({ provider: 'none' } as never).includes('off'));
check('doctor: connected to host', line({ provider: 'imap', host: 'imap.example.test', user: 'u', hasPassword: true } as never).includes('connected to imap.example.test'));
check('doctor: missing password is flagged', /password/.test(renderDoctorReport(buildDoctorReport({ ...base, email: { provider: 'imap', host: 'h', user: 'u', hasPassword: false } })).join('\n')));

fs.rmSync(tmp, { recursive: true, force: true });
const failed = checks.filter(([, ok]) => !ok);
if (failed.length) { console.error(`${failed.length} failed`); process.exit(1); }
console.log(`\nV142 checks passed (${checks.length}).`);
