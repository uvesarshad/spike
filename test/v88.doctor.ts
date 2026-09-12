/* V88 — `spike doctor`'s line builder (A21, P1).
 *
 * There was no preflight at all: "will a run work on this machine, and what
 * will it be allowed to do?" could only be answered by starting a run and
 * watching it fail. `spike doctor` answers it up front, and src/doctor.ts is
 * the pure half that decides ✓ / ! / ✗ and which fix hint to print.
 *
 * This suite exercises ONLY that pure half, with hand-written probe snapshots
 * — no Chrome, no on-device model, no adapter's real available(), no network,
 * no filesystem. (cli.ts owns the real probing; keeping the decision logic
 * separate from it is what makes this testable in the fast bucket at all.)
 *
 * Covers:
 *   1. a fully healthy machine is all ✓ and exits 0
 *   2. a missing Chrome is ✗, carries a fix hint, and exits 1
 *   3. an unreachable NAVIGATOR with no fallback is ✗ (a run cannot take a step)
 *   4. an unreachable navigator WITH a ladder fallback softens to ! and names
 *      the model that would actually run — the run works, but not as configured
 *   5. an unreachable BRAIN / visual check is only ! (both degrade gracefully)
 *   6. the on-device model's three not-ready states each get their own hint
 *   7. look-only mode and strict-checks-off are surfaced as warnings, since
 *      both silently change what a run does
 *   8. hints are printed for failures/warnings and never for passing checks
 *   9. the role headings are the developer-facing "Navigator"/"Brain" names
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDoctorReport,
  doctorExitCode,
  renderDoctorReport,
  type DoctorInput,
  type DoctorSection,
} from '../src/doctor.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const HEALTHY: DoctorInput = {
  chrome: { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  nano: { availability: 'available' },
  roles: [
    { role: 'navigator', pin: 'gemini:api', adapter: 'byok-gemini', model: 'gemini-3-flash', available: true },
    { role: 'brain', pin: 'claude:cli', adapter: 'claude-cli', model: 'claude-sonnet-5', available: true },
    { role: 'visual', pin: 'the on-device model', available: true },
  ],
  run: { readOnly: false, via: 'cdp', allowedHosts: ['localhost', '127.0.0.1'], strictOracles: true },
};

const clone = (over: Partial<DoctorInput>): DoctorInput => ({ ...HEALTHY, ...over });

function flat(sections: DoctorSection[]): string {
  return renderDoctorReport(sections).join('\n');
}
function lineFor(sections: DoctorSection[], labelFragment: string): string | undefined {
  return renderDoctorReport(sections).find((l) => l.includes(labelFragment) && /^\s{2}[✓!✗] /.test(l));
}

/* ---------- 1. healthy machine ---------- */
{
  const sections = buildDoctorReport(HEALTHY);
  const text = flat(sections);
  check('a healthy machine has no ✗ lines', !text.includes('✗'));
  check('a healthy machine has no ! lines', !text.includes('! '));
  check('a healthy machine exits 0', doctorExitCode(sections) === 0);
  check('it names the Chrome it found', text.includes('/Applications/Google Chrome.app'));
  check('it names the model behind each role', text.includes('byok-gemini (gemini-3-flash)') && text.includes('claude-cli (claude-sonnet-5)'));
  check('nothing prints a fix hint when everything passes', !text.includes('fix:'));
}

/* ---------- 2. Chrome missing ---------- */
{
  const sections = buildDoctorReport(clone({ chrome: { error: 'install Google Chrome first' } }));
  const line = lineFor(sections, 'Chrome');
  check('a missing Chrome is ✗', Boolean(line?.startsWith('  ✗')) && Boolean(line?.includes('not found')));
  check("a missing Chrome prints the caller's fix hint", flat(sections).includes('fix: install Google Chrome first'));
  check('a missing Chrome exits 1', doctorExitCode(sections) === 1);
}
{
  // no hint supplied by the caller → the built-in one still tells you what to do
  const sections = buildDoctorReport(clone({ chrome: {} }));
  check('a missing Chrome always has some fix hint', /fix: .*Chrome/i.test(flat(sections)));
}

/* ---------- 3/4. navigator ---------- */
{
  const sections = buildDoctorReport(
    clone({
      roles: [
        { role: 'navigator', pin: 'nano:ondevice', available: false, reason: 'the on-device model is not ready' },
        HEALTHY.roles[1],
        HEALTHY.roles[2],
      ],
    }),
  );
  const line = lineFor(sections, 'Navigator');
  check('an unreachable navigator with no fallback is ✗', Boolean(line?.startsWith('  ✗')));
  check('it says why', Boolean(line?.includes('the on-device model is not ready')));
  check('it exits 1', doctorExitCode(sections) === 1);
  check('its hint names a command that fixes it', /fix: .*spike config set --navigator-provider/.test(flat(sections)));
}
{
  const sections = buildDoctorReport(
    clone({
      roles: [
        { role: 'navigator', pin: 'nano:ondevice', available: false, reason: 'the on-device model is not ready', fallback: 'anthropic' },
        HEALTHY.roles[1],
        HEALTHY.roles[2],
      ],
    }),
  );
  const line = lineFor(sections, 'Navigator');
  check('an unreachable navigator WITH a fallback is only !', Boolean(line?.startsWith('  !')));
  check('it names the model that would actually run', Boolean(line?.includes('a run would use anthropic instead')));
  check('a working fallback keeps the exit code green', doctorExitCode(sections) === 0);
}

/* ---------- 5. brain + visual degrade gracefully ---------- */
{
  const sections = buildDoctorReport(
    clone({
      roles: [
        HEALTHY.roles[0],
        { role: 'brain', pin: 'claude:cli', adapter: 'claude-cli', available: false, reason: 'not configured' },
        { role: 'visual', pin: 'none configured', available: false, reason: 'no vision model is reachable' },
      ],
    }),
  );
  check('an unreachable brain is ! not ✗', Boolean(lineFor(sections, 'Brain')?.startsWith('  !')));
  check('an unreachable visual check is ! not ✗', Boolean(lineFor(sections, 'Visual check')?.startsWith('  !')));
  check('neither reddens the exit code on its own', doctorExitCode(sections) === 0);
  check('the brain hint says runs still work without it', /fix: runs keep working with the navigator alone/.test(flat(sections)));
}

/* ---------- 6. on-device model states ---------- */
{
  const hintFor = (nano: DoctorInput['nano']): string => flat(buildDoctorReport(clone({ nano })));
  check('not-downloaded points at `spike nano --download`', hintFor({ availability: 'downloadable' }).includes('spike nano --download'));
  check('mid-download says so', hintFor({ availability: 'downloading' }).includes('still downloading'));
  check('unavailable explains the 22GB gate', hintFor({ availability: 'unavailable' }).includes('22GB free'));
  check('a probe error degrades to !, never ✗', lineFor(buildDoctorReport(clone({ nano: { error: 'timed out after 45s' } })), 'On-device model')?.startsWith('  !') === true);
  check('a missing on-device model never fails the preflight', doctorExitCode(buildDoctorReport(clone({ nano: { availability: 'unavailable' } }))) === 0);
}

/* ---------- 7. what a run would do ---------- */
{
  const sections = buildDoctorReport(clone({ run: { readOnly: true, via: 'extension', allowedHosts: [], strictOracles: false } }));
  const text = flat(sections);
  check('look-only mode on is flagged as a warning', Boolean(lineFor(sections, 'Look-only mode')?.startsWith('  !')));
  check('look-only mode explains what it prevents', text.includes('never click, type or submit'));
  check('strict checks off is flagged as a warning', Boolean(lineFor(sections, 'Strict checks')?.startsWith('  !')));
  check('strict checks off points at the new config flag', text.includes('spike config set --strict-oracles on'));
  check('the transport is reported', Boolean(lineFor(sections, 'How Chrome is driven')?.includes('extension')));
  check('an empty host allowlist still says --url is trusted', text.includes('(none configured)') && text.includes('--url'));
  check('a look-only/loose-check machine is still exit 0 (it works, it just does less)', doctorExitCode(sections) === 0);
}
{
  const text = flat(buildDoctorReport(HEALTHY));
  check('the configured hosts are listed', text.includes('localhost, 127.0.0.1'));
  check('look-only off reads as permission to act', text.includes('off — the agent may click and type'));
}

/* ---------- 9. developer-facing role vocabulary ---------- */
{
  const text = flat(buildDoctorReport(HEALTHY));
  // A21 explicitly keeps the two capability role names as headings on this
  // expert CLI surface — the §1.5 jargon ban covers the panel, not `doctor`.
  check('the roles keep their real names', text.includes('Navigator (the model that clicks)') && text.includes('Brain (the model that plans)'));
  check('every check line starts with exactly one status mark', renderDoctorReport(buildDoctorReport(HEALTHY)).filter((l) => l.startsWith('  ')).every((l) => /^ {2}[✓!✗] \S/.test(l)));
}

/* ---------- 10. A28: no internal audit IDs in any --help string ---------- */
{
  const cliSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli.ts'), 'utf8');
  // Every commander help string: .description(...), .option(...), .argument(...).
  const helpStrings = [...cliSrc.matchAll(/^\s*\.(?:description|option|argument)\((.*)$/gm)].map((m) => m[1]);
  const leaking = helpStrings.filter((s) => /\(A\d+\)/.test(s));
  check('no --help string carries an internal audit ID', leaking.length === 0);
  if (leaking.length) console.error(leaking.join('\n'));
  check('the new config flags are registered', /--navigator-provider/.test(cliSrc) && /--navigator-mode/.test(cliSrc) && /--navigator-model/.test(cliSrc) && /--strict-oracles/.test(cliSrc));
  check('config show prints both role headings', /Navigator \(the model that clicks\)/.test(cliSrc) && /Brain \(the model that plans\)/.test(cliSrc));
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv88: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error('FAILED: ' + failed.map(([l]) => l).join(', '));
  process.exit(1);
}
