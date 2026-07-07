import type { NanoVerdict } from '../ports/nano-port.js';
import type { ModelRouter, VisualCandidate } from '../router/model-router.js';

export type AssertionPolicy = 'single-ladder' | 'fail-on-disagreement' | 'arbiter-on-disagreement';

export interface AssertionModelResult {
  adapter: string;
  rung: number;
  verdict: NanoVerdict;
}

export interface AssertionTraceEntry {
  step: number;
  policy: AssertionPolicy;
  expectation: string;
  verdict: NanoVerdict['verdict'];
  summary: string;
  disagreement: boolean;
  primary?: AssertionModelResult;
  secondary?: AssertionModelResult;
  arbiter?: AssertionModelResult;
}

export interface AssertionResult {
  verdict: NanoVerdict;
  trace: AssertionTraceEntry;
}

export async function runVisualAssertion(
  router: ModelRouter,
  png: Buffer,
  expectation: string,
  step: number,
  policy: AssertionPolicy,
): Promise<AssertionResult> {
  if (policy === 'single-ladder') {
    const verdict = await router.visualVerdict(png, expectation, step);
    return {
      verdict,
      trace: {
        step,
        policy,
        expectation,
        verdict: verdict.verdict,
        summary: verdict.summary,
        disagreement: false,
      },
    };
  }

  const candidates = await router.visualVerdictCandidates();
  if (candidates.length < 2) {
    const verdict = await router.visualVerdict(png, expectation, step);
    return {
      verdict,
      trace: {
        step,
        policy,
        expectation,
        verdict: verdict.verdict,
        summary: `consensus unavailable; only ${candidates.length} visual adapter(s) ready. ${verdict.summary}`,
        disagreement: false,
        ...(candidates[0] && { primary: toModelResult(candidates[0], verdict) }),
      },
    };
  }

  const primary = await router.visualVerdictWith(candidates[0], png, expectation, step, 'assertion primary');
  const secondary = await router.visualVerdictWith(candidates[1], png, expectation, step, 'assertion secondary');
  const disagreement = primary.verdict.verdict !== secondary.verdict.verdict;

  if (!disagreement) {
    const verdict = mergeAgreement(primary.verdict, secondary.verdict);
    return {
      verdict,
      trace: {
        step,
        policy,
        expectation,
        verdict: verdict.verdict,
        summary: verdict.summary,
        disagreement: false,
        primary: toModelResult(candidates[0], primary.verdict),
        secondary: toModelResult(candidates[1], secondary.verdict),
      },
    };
  }

  if (policy === 'fail-on-disagreement') {
    const verdict: NanoVerdict = {
      verdict: 'fail',
      summary: `visual assertion disagreement: ${candidates[0].name}=${primary.verdict.verdict}; ${candidates[1].name}=${secondary.verdict.verdict}`,
      issues: [
        ...primary.verdict.issues,
        ...secondary.verdict.issues,
        primary.verdict.summary,
        secondary.verdict.summary,
      ].filter(Boolean),
    };
    return {
      verdict,
      trace: {
        step,
        policy,
        expectation,
        verdict: verdict.verdict,
        summary: verdict.summary,
        disagreement: true,
        primary: toModelResult(candidates[0], primary.verdict),
        secondary: toModelResult(candidates[1], secondary.verdict),
      },
    };
  }

  const arbiterCandidate = candidates[2] ?? candidates[0];
  const arbiterExpectation =
    `${expectation}\n\nTwo visual judges disagreed. ` +
    `${candidates[0].name} said ${primary.verdict.verdict}: ${primary.verdict.summary}. ` +
    `${candidates[1].name} said ${secondary.verdict.verdict}: ${secondary.verdict.summary}. ` +
    'Arbitrate the final verdict from the screenshot.';
  const arbiter = await router.visualVerdictWith(arbiterCandidate, png, arbiterExpectation, step, 'assertion arbiter');
  return {
    verdict: arbiter.verdict,
    trace: {
      step,
      policy,
      expectation,
      verdict: arbiter.verdict.verdict,
      summary: `arbiter ${arbiterCandidate.name}: ${arbiter.verdict.summary}`,
      disagreement: true,
      primary: toModelResult(candidates[0], primary.verdict),
      secondary: toModelResult(candidates[1], secondary.verdict),
      arbiter: toModelResult(arbiterCandidate, arbiter.verdict),
    },
  };
}

function mergeAgreement(a: NanoVerdict, b: NanoVerdict): NanoVerdict {
  return {
    verdict: a.verdict,
    summary: [a.summary, b.summary].filter(Boolean).join(' / '),
    issues: [...a.issues, ...b.issues],
  };
}

function toModelResult(candidate: VisualCandidate, verdict: NanoVerdict): AssertionModelResult {
  return {
    adapter: candidate.name,
    rung: candidate.rung,
    verdict,
  };
}
