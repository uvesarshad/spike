import type { NanoVerdict } from '../ports/nano-port.js';

export type VisualAssertionPolicyType =
  | 'single-ladder'
  | 'fail-on-disagreement'
  | 'arbiter-on-disagreement';

export interface VisualAssertionRequest {
  png: Buffer;
  expectation: string;
  step: number;
}

export interface VisualVerdictJudge {
  readonly name: string;
  judge(req: VisualAssertionRequest): Promise<NanoVerdict>;
}

type ConsensusJudges = readonly [VisualVerdictJudge, VisualVerdictJudge, ...VisualVerdictJudge[]];

export type VisualAssertionPolicy =
  | {
      type: 'single-ladder';
      judge: VisualVerdictJudge;
    }
  | {
      type: 'fail-on-disagreement';
      judges: ConsensusJudges;
    }
  | {
      type: 'arbiter-on-disagreement';
      judges: ConsensusJudges;
      arbiter: VisualVerdictJudge;
    };

export interface VisualPolicyJudgment {
  judge: string;
  role: 'ladder' | 'consensus' | 'arbiter';
  verdict: NanoVerdict;
}

export interface VisualPolicyResult {
  policy: VisualAssertionPolicyType;
  verdict: NanoVerdict;
  disagreed: boolean;
  judgments: VisualPolicyJudgment[];
}

export async function evaluateVisualAssertion(
  policy: VisualAssertionPolicy,
  req: VisualAssertionRequest,
): Promise<VisualPolicyResult> {
  switch (policy.type) {
    case 'single-ladder': {
      const verdict = normalizeVerdict(await policy.judge.judge(req));
      return {
        policy: policy.type,
        verdict,
        disagreed: false,
        judgments: [{ judge: policy.judge.name, role: 'ladder', verdict }],
      };
    }
    case 'fail-on-disagreement': {
      const judgments = await judgeAll(policy.judges, req);
      const disagreed = hasDisagreement(judgments);
      return {
        policy: policy.type,
        verdict: disagreed ? disagreementVerdict(judgments) : mergeAgreement(judgments),
        disagreed,
        judgments,
      };
    }
    case 'arbiter-on-disagreement': {
      const judgments = await judgeAll(policy.judges, req);
      const disagreed = hasDisagreement(judgments);
      if (!disagreed) {
        return {
          policy: policy.type,
          verdict: mergeAgreement(judgments),
          disagreed,
          judgments,
        };
      }
      const arbiterVerdict = normalizeVerdict(await policy.arbiter.judge(req));
      return {
        policy: policy.type,
        verdict: arbiterVerdict,
        disagreed,
        judgments: [...judgments, { judge: policy.arbiter.name, role: 'arbiter', verdict: arbiterVerdict }],
      };
    }
  }
}

async function judgeAll(
  judges: ConsensusJudges,
  req: VisualAssertionRequest,
): Promise<VisualPolicyJudgment[]> {
  return Promise.all(
    judges.map(async (judge) => ({
      judge: judge.name,
      role: 'consensus' as const,
      verdict: normalizeVerdict(await judge.judge(req)),
    })),
  );
}

function normalizeVerdict(raw: NanoVerdict): NanoVerdict {
  return {
    verdict: raw.verdict === 'pass' || raw.verdict === 'fail' ? raw.verdict : 'uncertain',
    summary: raw.summary ?? '',
    issues: Array.isArray(raw.issues) ? raw.issues : [],
  };
}

function hasDisagreement(judgments: readonly VisualPolicyJudgment[]): boolean {
  return new Set(judgments.map((j) => j.verdict.verdict)).size > 1;
}

function mergeAgreement(judgments: readonly VisualPolicyJudgment[]): NanoVerdict {
  const [first] = judgments;
  return {
    verdict: first.verdict.verdict,
    summary: first.verdict.summary,
    issues: unique(judgments.flatMap((j) => j.verdict.issues)),
  };
}

function disagreementVerdict(judgments: readonly VisualPolicyJudgment[]): NanoVerdict {
  const summary = `visual judges disagreed: ${judgments
    .map((j) => `${j.judge}=${j.verdict.verdict}`)
    .join(', ')}`;
  return {
    verdict: 'fail',
    summary,
    issues: unique(['visual verdict disagreement', ...judgments.flatMap((j) => j.verdict.issues)]),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}
