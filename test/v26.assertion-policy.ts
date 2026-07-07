import {
  evaluateVisualAssertion,
  type VisualAssertionRequest,
  type VisualVerdictJudge,
} from '../src/assertions/visual-policy.js';
import type { NanoVerdict } from '../src/ports/nano-port.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const request: VisualAssertionRequest = {
  png: Buffer.from('fakepng'),
  expectation: 'checkout confirmation is visible',
  step: 7,
};

function verdict(verdict: NanoVerdict['verdict'], summary: string = verdict): NanoVerdict {
  return { verdict, summary, issues: verdict === 'fail' ? ['visible problem'] : [] };
}

function judge(name: string, out: NanoVerdict, calls: string[]): VisualVerdictJudge {
  return {
    name,
    judge: async (req) => {
      calls.push(`${name}:${req.step}:${req.expectation}`);
      return out;
    },
  };
}

{
  const calls: string[] = [];
  const result = await evaluateVisualAssertion(
    { type: 'single-ladder', judge: judge('router.visualVerdict', verdict('pass'), calls) },
    request,
  );

  check('single-ladder returns the ladder verdict', result.verdict.verdict === 'pass');
  check('single-ladder calls one judge', calls.length === 1 && result.judgments.length === 1);
}

{
  const calls: string[] = [];
  const result = await evaluateVisualAssertion(
    {
      type: 'fail-on-disagreement',
      judges: [judge('nano', verdict('pass'), calls), judge('google-cli', verdict('pass'), calls)],
    },
    request,
  );

  check('fail-on-disagreement accepts agreement', result.verdict.verdict === 'pass' && !result.disagreed);
  check('agreement calls both consensus judges', calls.length === 2 && result.judgments.length === 2);
}

{
  const calls: string[] = [];
  const result = await evaluateVisualAssertion(
    {
      type: 'fail-on-disagreement',
      judges: [judge('nano', verdict('pass'), calls), judge('google-cli', verdict('fail'), calls)],
    },
    request,
  );

  check('fail-on-disagreement fails on disagreement', result.verdict.verdict === 'fail' && result.disagreed);
  check(
    'disagreement summary names judges',
    result.verdict.summary.includes('nano=pass') && result.verdict.summary.includes('google-cli=fail'),
  );
}

{
  const calls: string[] = [];
  const result = await evaluateVisualAssertion(
    {
      type: 'arbiter-on-disagreement',
      judges: [judge('nano', verdict('pass'), calls), judge('google-cli', verdict('pass'), calls)],
      arbiter: judge('byok-arbiter', verdict('fail'), calls),
    },
    request,
  );

  check('arbiter is skipped when consensus agrees', result.verdict.verdict === 'pass' && calls.length === 2);
}

{
  const calls: string[] = [];
  const result = await evaluateVisualAssertion(
    {
      type: 'arbiter-on-disagreement',
      judges: [judge('nano', verdict('pass'), calls), judge('google-cli', verdict('fail'), calls)],
      arbiter: judge('byok-arbiter', verdict('pass', 'arbiter saw success'), calls),
    },
    request,
  );

  check('arbiter-on-disagreement returns arbiter verdict', result.verdict.verdict === 'pass' && result.disagreed);
  check(
    'arbiter call is recorded after disagreement',
    calls.at(-1)?.startsWith('byok-arbiter:') === true && result.judgments.at(-1)?.role === 'arbiter',
  );
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
