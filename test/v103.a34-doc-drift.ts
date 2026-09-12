/* V103 — A34 follow-through: language-agnostic error detection, and
 * deterministic page checks reaching the fix prompt.
 *
 * Two behavior changes land together with the A34 doc-drift/dead-code sweep:
 *
 *   1. visibleErrorText (driver/loop.ts) used to require the literal English
 *      words "error"/"invalid" somewhere in the line's text. It now matches
 *      an alert-like AX role (alert/alertdialog/status) or an "invalid"
 *      AX state FIRST, regardless of what language the text itself is in,
 *      falling back to the English-word scan only when neither structural
 *      signal is present.
 *   2. buildFixPrompt (vibe/fix-prompt.ts) now surfaces the deterministic
 *      page/interaction checks (A16/A24 `StepRecord.invariants`) recorded
 *      across a run's steps as "Automated page check:" evidence lines — the
 *      same signal the models driving the run already read via
 *      planner-prompt.ts's formatHistory, previously absent from the fix
 *      prompt a human/coding-agent reads.
 *
 * Pure/in-memory: hand-built AX text and Report fixtures, no Chrome/model
 * calls.
 *
 * Run: npx tsx test/v103.a34-doc-drift.ts
 */

import { visibleErrorText } from '../src/driver/loop.js';
import { buildFixPrompt } from '../src/vibe/fix-prompt.js';
import type { Report, StepRecord } from '../src/report/report.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

// ---------------------------------------------------------------------------
// 1. visibleErrorText — language-agnostic structural signals
// ---------------------------------------------------------------------------

{
  // A French error banner with role="alert" — no English "error"/"invalid"
  // substring anywhere in the line. Lines mirror capture/axtree.ts's
  // serialized shape: "<id> <role> \"<name>\" (<states>)".
  const axText = ['n1 RootWebArea "Connexion"', '  n2 alert "Identifiants incorrects"', '  n3 button "Se connecter"'].join('\n');
  check('an alert-role node is matched regardless of language', visibleErrorText(axText) === 'Identifiants incorrects');
}

{
  // A textbox flagged aria-invalid, again with no English error wording.
  const axText = ['n1 RootWebArea "Formulaire"', '  n2 textbox "Courriel" (invalid, focused)', '  n3 button "Envoyer"'].join('\n');
  check('an aria-invalid control is matched regardless of language', visibleErrorText(axText) === 'Courriel');
}

{
  // English-word fallback still works when there is no structural signal.
  const axText = ['n1 RootWebArea "Login"', '  n2 StaticText "Error: invalid credentials"', '  n3 button "Sign in"'].join('\n');
  check('the English-word fallback still fires with no alert role/state', visibleErrorText(axText) === 'Error: invalid credentials');
}

{
  const axText = ['n1 RootWebArea "Home"', '  n2 button "Continue"'].join('\n');
  check('a clean page with neither signal returns null', visibleErrorText(axText) === null);
  check('undefined input returns null', visibleErrorText(undefined) === null);
}

// ---------------------------------------------------------------------------
// 2. buildFixPrompt — deterministic page checks as evidence
// ---------------------------------------------------------------------------

function stepWith(overrides: Partial<StepRecord>): StepRecord {
  return {
    index: 0,
    action: { type: 'click', nodeId: 'n1' },
    description: 'clicked the "Place order" button',
    ok: true,
    console: [],
    network: [],
    ts: Date.now(),
    ...overrides,
  } as unknown as StepRecord;
}

function reportWith(steps: StepRecord[]): Report {
  return {
    runId: 'r1',
    task: 'complete checkout',
    url: 'http://x.test/',
    verdict: 'fail',
    reason: 'the order button did nothing',
    failing_step: { index: 0, action: steps[0]!.action, description: steps[0]!.description },
    console_error: null,
    evidence_paths: [],
    steps,
    model_trace: [],
    durationMs: 1,
    tokenEstimate: 0,
  } as unknown as Report;
}

{
  const steps = [
    stepWith({
      invariants: [
        { rule: 'dead-interaction', severity: 'warn', detail: 'clicking "Place order" changed nothing on the page' },
      ],
    }),
  ];
  const prompt = buildFixPrompt(reportWith(steps));
  check(
    'a dead-interaction check on a step reaches the fix prompt as evidence',
    prompt.includes('Automated page check: clicking "Place order" changed nothing on the page'),
  );
}

{
  // No invariants recorded anywhere — no "Automated page check" noise.
  const steps = [stepWith({})];
  const prompt = buildFixPrompt(reportWith(steps));
  check('no page checks recorded means no "Automated page check" lines', !prompt.includes('Automated page check'));
}

{
  // A cap exists so a noisy page cannot blow out the prompt.
  const many = Array.from({ length: 20 }, (_, i) => ({ rule: 'r', severity: 'warn' as const, detail: `check number ${i}` }));
  const steps = [stepWith({ invariants: many })];
  const prompt = buildFixPrompt(reportWith(steps));
  const lines = prompt.split('\n').filter((l) => l.includes('Automated page check'));
  check('page checks in the fix prompt are capped, not unbounded', lines.length > 0 && lines.length < many.length);
}

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length}/${checks.length} checks failed`);
  process.exit(1);
} else {
  console.log(`\nall ${checks.length} checks passed`);
}
