/* `spike doctor` — the preflight the CLI never had (audit A21).
 *
 * "Will a run work on this machine, and what exactly will it do?" used to be
 * unanswerable without starting a run: `config show` printed only the brain,
 * never said whether the configured models were actually reachable, and never
 * showed the resolved read-only / transport / host-allowlist / strict-checks
 * posture that decides what a run is even allowed to do.
 *
 * This module is deliberately PURE: it takes an already-probed snapshot
 * (`DoctorInput`) and turns it into sections/lines. Nothing here launches
 * Chrome, calls `available()`, or touches the filesystem — cli.ts does all of
 * that and hands the results in. That is what makes the ✓/✗ logic and every
 * fix hint unit-testable in the fast bucket with zero real adapters.
 *
 * Vocabulary: `spike doctor` is an expert CLI surface, so the two capability
 * roles keep their real names ("Navigator", "Brain") as section headings —
 * the §1.5 jargon ban covers panel/report copy a non-developer reads, not the
 * developer CLI that already uses this vocabulary throughout.
 */

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  label: string;
  status: DoctorStatus;
  /** The value/answer itself — printed after the label on the same line. */
  detail?: string;
  /** What to do about it. Printed on its own indented line, and ONLY when the
   * check is not `ok` — a passing check never needs advice. */
  hint?: string;
}

export interface DoctorSection {
  title: string;
  checks: DoctorCheck[];
}

/** One model role's live state. `pin` is what the user configured
 * (`provider:mode`), `adapter` the ladder entry it actually resolved to (absent
 * when nothing on the ladder carries that name — e.g. an on-device pin). */
export interface DoctorRoleProbe {
  role: 'navigator' | 'brain' | 'visual';
  pin: string;
  adapter?: string;
  model?: string;
  available: boolean;
  /** Why it isn't available, when the caller knows. */
  reason?: string;
  /** Set when the pinned model is unreachable but the ladder has another
   * adapter that would take the role instead. The run still works, so this
   * softens a hard failure into a warning — while still saying out loud that
   * what runs is NOT what was configured. */
  fallback?: string;
}

export interface DoctorInput {
  chrome: { path?: string; error?: string };
  /** Result of the on-device model availability probe: 'available',
   * 'downloadable', 'downloading', 'unavailable', 'api-missing', or an error. */
  nano: { availability?: string; error?: string };
  roles: DoctorRoleProbe[];
  run: {
    readOnly: boolean;
    via: string;
    allowedHosts: string[];
    strictOracles: boolean;
  };
}

const ROLE_LABEL: Record<DoctorRoleProbe['role'], string> = {
  navigator: 'Navigator (the model that clicks)',
  brain: 'Brain (the model that plans)',
  visual: 'Visual check (judges a screenshot)',
};

/** A missing brain or visual adapter degrades gracefully (navigator-only
 * planning; console/DOM-only checks), so those are warnings. A missing
 * navigator means no run can take a single step — that is a hard failure. */
const ROLE_SEVERITY: Record<DoctorRoleProbe['role'], DoctorStatus> = {
  navigator: 'fail',
  brain: 'warn',
  visual: 'warn',
};

const ROLE_HINT: Record<DoctorRoleProbe['role'], string> = {
  navigator:
    'pick a reachable one: `spike config set --navigator-provider gemini --navigator-mode api` (then `spike secret set gemini`), or `--navigator-provider claude --navigator-mode cli` if Claude Code is on your PATH',
  brain:
    'runs keep working with the navigator alone, but plans are weaker. Set one: `spike config set --provider claude --mode cli` (Claude Code on PATH), or `--provider claude --mode api` plus `spike secret set anthropic`',
  visual:
    'screenshots will not be judged. Install the on-device model (`spike nano --download`) or configure a vision model, e.g. `spike config set --navigator-provider gemini --navigator-mode api`',
};

function chromeSection(input: DoctorInput): DoctorSection {
  const check: DoctorCheck = input.chrome.path
    ? { label: 'Chrome', status: 'ok', detail: input.chrome.path }
    : {
        label: 'Chrome',
        status: 'fail',
        detail: 'not found',
        hint:
          input.chrome.error ??
          'install Google Chrome, or point SPIKE_CHROME_PATH (or "chromePath" in spike.config.json) at the executable',
      };
  return { title: 'Browser', checks: [check] };
}

function nanoSection(input: DoctorInput): DoctorSection {
  const { availability, error } = input.nano;
  let check: DoctorCheck;
  if (error) {
    check = {
      label: 'On-device model (free, $0)',
      status: 'warn',
      detail: `could not be checked — ${error}`,
      hint: 'runs still work on a cloud model; `spike nano --check` reports the same thing on its own',
    };
  } else if (availability === 'available') {
    check = { label: 'On-device model (free, $0)', status: 'ok', detail: 'ready' };
  } else if (availability === 'downloadable' || availability === 'downloading') {
    check = {
      label: 'On-device model (free, $0)',
      status: 'warn',
      detail: availability === 'downloading' ? 'still downloading' : 'not downloaded yet',
      hint: 'run `spike nano --download` (~2GB, one time) to get the $0 rung',
    };
  } else {
    check = {
      label: 'On-device model (free, $0)',
      status: 'warn',
      detail: availability ?? 'unavailable',
      hint: 'needs branded Google Chrome and 22GB free on the drive holding the Chrome profile; runs still work on a cloud model without it',
    };
  }
  return { title: 'On-device model', checks: [check] };
}

function modelsSection(input: DoctorInput): DoctorSection {
  const checks = input.roles.map((r): DoctorCheck => {
    const who = r.adapter ?? r.pin;
    const named = r.model ? `${who} (${r.model})` : who;
    if (r.available) return { label: ROLE_LABEL[r.role], status: 'ok', detail: `${named} — reachable` };
    if (r.fallback) {
      return {
        label: ROLE_LABEL[r.role],
        status: 'warn',
        detail: `${named} — ${r.reason ?? 'not reachable'}; a run would use ${r.fallback} instead`,
        hint: ROLE_HINT[r.role],
      };
    }
    return {
      label: ROLE_LABEL[r.role],
      status: ROLE_SEVERITY[r.role],
      detail: `${named} — ${r.reason ?? 'not reachable'}`,
      hint: ROLE_HINT[r.role],
    };
  });
  return { title: 'Models', checks };
}

function runSection(input: DoctorInput): DoctorSection {
  const { readOnly, via, allowedHosts, strictOracles } = input.run;
  const checks: DoctorCheck[] = [
    readOnly
      ? {
          label: 'Look-only mode',
          status: 'warn',
          detail: 'on — the agent will look but never click, type or submit',
          hint: 'a run that must click needs it off: `spike config set` has no switch, so use SPIKE_READ_ONLY=0 (naming --url on the command line already turns it off for that run)',
        }
      : { label: 'Look-only mode', status: 'ok', detail: 'off — the agent may click and type' },
    { label: 'How Chrome is driven', status: 'ok', detail: via },
    {
      label: 'Sites it may click on',
      status: 'ok',
      detail: `${allowedHosts.join(', ') || '(none configured)'} — plus whatever host you name with --url`,
    },
    strictOracles
      ? { label: 'Strict checks', status: 'ok', detail: 'on — a failed check forces a fail verdict, whatever the model says' }
      : {
          label: 'Strict checks',
          status: 'warn',
          detail: 'off — the model alone decides the verdict',
          hint: 'turn them back on with `spike config set --strict-oracles on`',
        },
  ];
  return { title: 'What a run would do right now', checks };
}

/** The whole report, in print order. Pure — see the file header. */
export function buildDoctorReport(input: DoctorInput): DoctorSection[] {
  return [chromeSection(input), nanoSection(input), modelsSection(input), runSection(input)];
}

const MARK: Record<DoctorStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

/** Render sections to printable lines (no trailing newlines, one array entry
 * per line) — a section title, then `  ✓ label — detail`, then an indented
 * `      fix: hint` line for anything that is not ok. */
export function renderDoctorReport(sections: DoctorSection[]): string[] {
  const lines: string[] = [];
  for (const section of sections) {
    if (lines.length) lines.push('');
    lines.push(`${section.title}:`);
    for (const c of section.checks) {
      lines.push(`  ${MARK[c.status]} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
      if (c.status !== 'ok' && c.hint) lines.push(`      fix: ${c.hint}`);
    }
  }
  return lines;
}

/** 0 when nothing failed, 1 when at least one check did. Warnings never turn
 * the exit code red — an absent on-device model or an unset brain is a
 * degraded-but-working machine, not a broken one. */
export function doctorExitCode(sections: DoctorSection[]): 0 | 1 {
  return sections.some((s) => s.checks.some((c) => c.status === 'fail')) ? 1 : 0;
}
