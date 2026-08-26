/* V52 — CLI-adapter hardening (market-readiness audit A4/A5/A24). Offline +
 * deterministic (no fixture server, no real gemini/claude/codex CLI needed —
 * every process this suite spawns is `node` itself, used as a controllable
 * stand-in for "a CLI that hangs" / "a CLI that exits before we finish
 * writing its stdin"):
 *
 *  A4  — the `--version` availability probe must not hang forever: a probe
 *        that never exits resolves `available()` to false within a bounded
 *        timeout (not the full CLI-call timeout), and the ModelRouter still
 *        falls through the ladder to the next adapter.
 *  A5  — a child that exits (or never reads stdin) before/while we write to
 *        its stdin must not crash the process via an uncaught EPIPE /
 *        ERR_STREAM_WRITE_AFTER_END stream error.
 *  A24 — a timed-out CLI call kills the whole process GROUP (not just the
 *        shell:true wrapper), via `process.kill(-pid, 'SIGKILL')` on POSIX. */

import { GoogleCliAdapter, killProcessGroup as killGroupGoogle } from '../src/router/adapters/google-cli.js';
import { CliPlannerAdapter, killProcessGroup as killGroupCli } from '../src/router/adapters/cli-planner.js';
import { ModelRouter } from '../src/router/model-router.js';
import type { Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';
import type { ChildProcess } from 'node:child_process';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

function fake(name: string, rung: 0 | 1 | 2 | 3, caps: Capability[], impl: (req: JsonRequest) => unknown): ModelAdapter {
  return {
    name,
    rung,
    available: async () => true,
    supports: (c) => caps.includes(c),
    generateJson: async (req) => impl(req),
  };
}

// A never-exits-within-any-reasonable-window child, expressed as `sh -c
// 'sleep 4'` — every adapter appends its own trailing flags (`--version`,
// `-p "..." -m ... -e none -o json`) onto `bin`; those land as ADDITIONAL
// positional args to the wrapping `sh -c` invocation (not re-parsed into the
// quoted command string), so `sleep 4` always runs regardless of what gets
// appended. (An earlier `node -e "..."` version broke this: Node reparses
// `--version` appearing anywhere in argv as ITS OWN flag and exits
// immediately, which is the opposite of what a "hung CLI" stub needs.)
const HANGING_BIN = `sh -c 'sleep 4'`;
const okPlan = { thought: 'x', actions: [{ type: 'finish', verdict: 'pass', reason: 'done' }] };

/* ---------- A4: bounded availability-probe timeout ---------- */

{
  const t0 = Date.now();
  const google = new GoogleCliAdapter({ bin: HANGING_BIN, model: 'x', env: {}, availabilityProbeTimeoutMs: 150 });
  const value = await google.available();
  const elapsed = Date.now() - t0;
  check('google-cli: hung --version probe resolves unavailable (not throws)', value === false);
  check(
    `google-cli: hung probe resolves in ~150ms, not the process's own 4000ms lifetime (was ${elapsed}ms)`,
    elapsed < 1500,
  );
  // the negative result must land in the TTL cache exactly like a real
  // "binary not found" probe does — a fresh re-read must not re-spawn.
  const cached = (google as unknown as { availableCache: { value: boolean; at: number } | null }).availableCache;
  check('google-cli: the timed-out probe result is cached', cached?.value === false);
}

{
  const t0 = Date.now();
  const cli = new CliPlannerAdapter({ bin: HANGING_BIN as unknown as 'claude', model: undefined, availabilityProbeTimeoutMs: 150 });
  const value = await cli.available();
  const elapsed = Date.now() - t0;
  check('cli-planner: hung --version probe resolves unavailable (not throws)', value === false);
  check(`cli-planner: hung probe resolves in ~150ms (was ${elapsed}ms)`, elapsed < 1500);
}

{
  // router-level consequence: a rung-1 adapter whose availability probe hangs
  // must not deadlock plan-step for the whole ladder — the router should
  // still resolve, having fallen through to the next available adapter.
  const hungGoogle = new GoogleCliAdapter({ bin: HANGING_BIN, model: 'x', env: {}, availabilityProbeTimeoutMs: 150 });
  const fallback = fake('fallback-fake', 2, ['plan-step'], () => okPlan);
  const router = new ModelRouter([hungGoogle, fallback], {});
  const t0 = Date.now();
  await router.planJson('plan!', {}, 1);
  const elapsed = Date.now() - t0;
  check('router: falls through the ladder past a hung-probe adapter', router.trace[0]?.adapter === 'fallback-fake');
  check(`router: fell through quickly, not after the CLI's own 4000ms lifetime (was ${elapsed}ms)`, elapsed < 1500);
}

/* ---------- A5: stdin write error must not crash the process ---------- */

{
  // `false` exits almost immediately and never reads stdin — writing a
  // sizeable payload to its stdin pipe after it exits is the real-world EPIPE
  // trigger this finding is about. A `process.on('uncaughtException')` net is
  // the actual regression guard: pre-fix, an EPIPE here throws asynchronously
  // with nothing listening, which crashes the whole process (this test
  // script) before it ever reaches its own PASS/FAIL summary — so simply
  // completing this block IS part of the assertion. The handler below also
  // makes the check self-reporting instead of silently exiting nonzero.
  let uncaught: Error | null = null;
  const onUncaught = (err: Error) => {
    uncaught = err;
  };
  process.on('uncaughtException', onUncaught);
  const bigText = 'x'.repeat(2_000_000); // large enough to still be mid-write if the child has already exited
  try {
    for (let i = 0; i < 5; i++) {
      const adapter = new GoogleCliAdapter({ bin: 'false', model: 'x', env: {}, timeoutMs: 5000 });
      try {
        await adapter.generateJson({ prompt: bigText, schema: { type: 'object' } });
      } catch {
        // expected — `false` exits nonzero, or the CLI-shaped error path
        // fires; either is a clean rejection, not a crash.
      }
    }
    for (let i = 0; i < 5; i++) {
      const adapter = new CliPlannerAdapter({ bin: 'false' as unknown as 'claude', model: undefined, timeoutMs: 5000 });
      try {
        await adapter.generateJson({ prompt: bigText, schema: { type: 'object' } });
      } catch {
        // expected — same as above.
      }
    }
    // give any deferred 'error' event a turn to fire before we check.
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  check('google-cli/cli-planner: EPIPE on stdin write never surfaces as an uncaught exception', uncaught === null);
}

/* ---------- A24: process-group kill call shape ---------- */

if (process.platform === 'win32') {
  console.log('SKIP  A24 group-kill call shape (win32 taskkill path not unit-tested on this platform)');
} else {
  // Fake ChildProcess stand-in — per the task's "don't spawn a real
  // long-lived process" instruction, this exercises killProcessGroup()'s call
  // shape directly rather than waiting out a real CLI's timeout.
  const realKill = process.kill;
  const calls: Array<[number, NodeJS.Signals | number]> = [];
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    calls.push([pid, signal as NodeJS.Signals | number]);
    return true;
  }) as typeof process.kill;
  try {
    const fakeChild = { pid: 424242, kill: () => true } as unknown as ChildProcess;
    killGroupGoogle(fakeChild);
    check(
      'google-cli killProcessGroup: signals the NEGATIVE pid (the whole process group), not the child pid, with SIGKILL',
      calls.length === 1 && calls[0][0] === -424242 && calls[0][1] === 'SIGKILL',
    );

    calls.length = 0;
    killGroupCli(fakeChild);
    check(
      'cli-planner killProcessGroup: signals the NEGATIVE pid (the whole process group), not the child pid, with SIGKILL',
      calls.length === 1 && calls[0][0] === -424242 && calls[0][1] === 'SIGKILL',
    );
  } finally {
    process.kill = realKill;
  }

  // Fallback path: process.kill throwing (group already gone) must signal the
  // child directly rather than propagating the throw.
  process.kill = (() => {
    throw new Error('ESRCH');
  }) as typeof process.kill;
  try {
    let fallbackKillCalled = false;
    let fallbackSignal: unknown;
    const fakeChild = {
      pid: 999,
      kill: (signal?: NodeJS.Signals | number) => {
        fallbackKillCalled = true;
        fallbackSignal = signal;
        return true;
      },
    } as unknown as ChildProcess;
    killGroupGoogle(fakeChild);
    check(
      'google-cli killProcessGroup: falls back to child.kill(SIGKILL) when the group signal throws (ESRCH)',
      fallbackKillCalled && fallbackSignal === 'SIGKILL',
    );
  } finally {
    process.kill = realKill;
  }
}

/* ---------- A24 (integration): a timed-out call does not wait for the child's own lifetime ---------- */

{
  // The child (node, sleeping 4s) genuinely outlives the adapter's timeoutMs
  // (150ms) — but the adapter must reject promptly once it kills the group,
  // not linger until the child's natural exit. Bounded well under the
  // child's own 4000ms lifetime, so this stays fast.
  const adapter = new GoogleCliAdapter({ bin: HANGING_BIN, model: 'x', env: {}, timeoutMs: 150 });
  const t0 = Date.now();
  let message = '';
  try {
    await adapter.generateJson({ prompt: 'hi', schema: { type: 'object' } });
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  const elapsed = Date.now() - t0;
  check('google-cli: a timed-out call rejects with a "timed out" message', /timed out/i.test(message));
  check(`google-cli: a timed-out call rejects promptly, not after the child's 4000ms lifetime (was ${elapsed}ms)`, elapsed < 2000);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
