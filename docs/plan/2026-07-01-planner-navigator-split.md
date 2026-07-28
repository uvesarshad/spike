# Planner / Navigator split — two-tier model architecture

> **Date:** 2026-07-01
> **Status:** Approved, not yet started
> **Source plan:** mirrors `~/.claude/plans/zany-plotting-frog.md` (approved 2026-07-01)

## Context

**The problem:** the product's whole reason to exist is cheap browser QA, but today it isn't cheap where it counts. In `src/driver/loop.ts` the loop calls `router.planJson(...)` on **every** step, and the router pins that to the user's ONE chosen model. So the *expensive* model re-reads the full a11y tree + growing history and picks an action on every single step — 12 expensive calls for a 12-step run, thousands for an hours-long run. That is exactly the cost blowup seen in existing tools. Nano is only ever used for `visualVerdict`; it never shares the per-step load.

**Intended outcome:** two tiers of model working together.
- **Navigator (cheap / free):** does the frequent grunt work — reads the page, executes clicks/types, does visual checks. Called on *every* step, so it must be cheap.
- **Planner / Brain (smart):** called *rarely* — makes the plan once and is re-consulted only when the navigator is stuck. Tells the navigator what to do; does not itself drive the page step-by-step.

This makes brain cost ~O(number of stuck events + 1) instead of O(number of steps), so a run can go for hours over complex apps at near-navigator cost. The two Settings cards ("Navigator" + "Brain") follow naturally from the engine change — the UI is the *last* phase, not the point.

## Locked decisions (from user Q&A)

1. **Cadence:** *Plan once, escalate on stuck.* Brain makes one sub-goal checklist at the start; the navigator runs all steps autonomously; the brain is re-consulted only on stuck/loop/invalid-output or an ambiguous final verdict.
2. **Navigator options:** cheap **vision cloud models** (Gemini Flash, Claude Haiku, gpt-4o-mini, OpenRouter) **and Gemini Nano** as a $0 on-device navigator — the Nano action-picker is **new work, gated by a spike** (Phase A). Automatic ladder fallback: if the pinned navigator is unavailable/stalls, the router falls through to the next available per-step adapter.
3. **Brain options:** smart models (default **Claude Sonnet**; also GLM-5.2, Gemini Pro/Flash, GPT-4o). Brain is text-only-capable (it works from a compact digest, not screenshots), so GLM-5.2 qualifies. **Nano is never the brain.**
4. **Defaults:** Navigator = **Nano** (free, on-device) with cloud fallback; Brain = **Claude Sonnet**. Both changeable in Settings. Out-of-box the brain needs an Anthropic key the user doesn't have yet → the panel must show an explicit "add your Brain key" prompt and degrade gracefully.
5. **Visual verdict:** unchanged — Nano (rung 0, $0) first, else a vision-capable navigator/cloud model.
6. **Cost accounting:** the report must attribute tokens/calls **per role** (navigator vs brain vs visual) to prove the split works.

## Architecture

Three model roles map onto the existing `Capability` + ladder + trace machinery (minimal churn):

| Role | Capability | Who | Frequency | Current code |
|------|-----------|-----|-----------|--------------|
| Brain (plan) | `plan-goals` (**NEW**) | smart, pinned `plannerAdapter` | rare (start + on stuck) | — |
| Navigator (step) | `plan-step` (**reused**) | cheap/free, pinned `navigatorAdapter` | every step | `router.planJson` |
| Visual verdict | `visual-verdict` (unchanged) | Nano → vision cloud | on `assert_visual` + finish confirm | `router.visualVerdict` |

### 1. Capability + adapter contract — `src/router/adapter.ts`
- Extend `type Capability = 'visual-verdict' | 'plan-step' | 'plan-goals'`.
- Every adapter that currently `supports('plan-step')` also supports `'plan-goals'` (same generateJson surface; only the prompt/schema differ), EXCEPT Nano: Nano supports `visual-verdict` and (after Phase A) `plan-step`, but **never** `plan-goals`.
- No new adapter methods — `generateJson({prompt, schema, imagePng?})` covers all three. `lastUsage` already gives per-call tokens for cost attribution.

### 2. Router — `src/router/model-router.ts`
- `ModelRouterOptions`: replace the single `pinnedAdapter?` with `navigatorAdapter?: string` (pins `plan-step`) and `plannerAdapter?: string` (pins `plan-goals`). Keep `pinnedAdapter` accepted as a back-compat alias applied to both when the new fields are absent.
- Add `planGoals(prompt, schema, step)` — same shape as the existing `planJson`, but ladder pinned via `plannerAdapter` and `candidates('plan-goals')`. Reuse the existing error-fallback + trace logic (factor the shared body out of `planJson`).
- Rename the intent of `planJson` → it's the **navigator** call (pinned via `navigatorAdapter`). Keep the method name to minimize churn, or alias `planStep`.
- `pinRank`/`candidates` already lead with the pinned adapter and keep Nano first for visual — extend so `plan-step` leads with `navigatorAdapter` and `plan-goals` leads with `plannerAdapter`.

### 3. Driver loop — `src/driver/loop.ts` (the core rewrite)
New shape (reuses all existing execute/drain/evidence/secret/read-only-guard/audit/token machinery — only *who is called and how often* changes):

1. **Initial plan (brain, 1 call):** snapshot tree → `router.planGoals(buildGoalPlannerPrompt(...))` → `{ thought, goals: string[] }`. Emit a `plan` step listing the goals.
2. **Navigator inner loop (cheap, every step):** track a `currentGoal` pointer. Each step: snapshot a11y tree → `router.planJson(buildNavigatorPrompt({task, goal: goals[currentGoal], goals, url, axText, history, ...}))` → 1–3 actions. Execute exactly as today (batching, loop-detection, retry-by-role+name, drains, audit, onStep). New navigator outputs:
   - `goal_complete` → advance `currentGoal`; if past the last goal, treat as `finish:pass` candidate.
   - `blocked`/`need_help` (with a reason) → **escalate**.
3. **Escalate to brain (rare):** triggered by `blocked`, same-action-3× loop detection (today this *fails* — change it to escalate first), invalid navigator JSON twice, or a per-goal step-budget overflow. Call `router.planGoals(...)` with the failure context; the brain returns revised remaining `goals`, a `hint` for the navigator, or a `finish` verdict. Only if the brain also can't make progress → end (`uncertain`/`fail`) as today.
4. **Finish/verdict:** navigator `finish:pass` → one Nano confirmation visual (as today). If the confirm disagrees or is `uncertain` → escalate to brain for the final call (cheap-then-smart). `finish:fail` → trust it (as today). This keeps verdicts navigator-cheap, brain only on disagreement.
5. **Budget:** raise/expose `maxSteps` for long runs (today 12 — far too small for "run for hours"); add an overall cap + keep the step budget as the safety net. Escalation-on-stuck bounds brain cost even at hundreds of steps.

### 4. Actions + prompts — `src/driver/actions.ts`, `src/driver/planner-prompt.ts`
- **Goal plan schema** (new): `GoalPlanSchema = { thought, goals: string[], verdict?, hint? }` + its `GOAL_PLAN_JSON_SCHEMA` twin (same in-prompt-steering recipe the existing schemas use).
- **Navigator result**: add `goal_complete` and `blocked` (reason) to the navigator's vocabulary — either as new `Action` variants or as sibling fields on `PlanResult` (`{thought, actions?, goalComplete?, blocked?}`). Prefer sibling fields so the executor's action switch is untouched.
- **`buildGoalPlannerPrompt`** (new): task + initial a11y digest (or a compact summary) → "produce an ordered checklist of sub-goals; you will NOT drive the page — a navigator executes each goal." Re-invoked with progress + failure context on escalation.
- **`buildNavigatorPrompt`** (rename/extend `buildPlannerPrompt`): inject `CURRENT GOAL` + the full goal list + a shorter history; instruct it to emit `goal_complete` when the current goal is met and `blocked` when stuck instead of looping.

### 5. Settings data — `src/vibe/settings-data.ts`
- `QaSettings`: keep `planner: PlannerSelection` as the **Brain** role; add `navigator: PlannerSelection`. Migration: a config with only `planner` → use it as brain, default navigator = Nano.
- `DEFAULT_SETTINGS`: `navigator: { provider: 'nano', mode: 'ondevice' }`, `planner: { provider: 'claude', mode: 'api', model: '' }` (brain = Claude Sonnet via role-default).
- Make model defaults **role-aware**: `defaultModelFor(provider, mode, role: 'navigator'|'brain')` → navigator = cheap tier (e.g. `gemini-3-flash-preview`, `claude-haiku-4-5`, `gpt-4o-mini`), brain = smart tier (e.g. Claude Sonnet id, `gemini-3-pro`, `gpt-4o`, `glm-5.2`). (Confirm exact Sonnet model id via `/claude-api` at build.)
- Add `nano` to the navigator-eligible list; keep `LITE_PLANNER_PROVIDERS` for the brain; add `LITE_NAVIGATOR_PROVIDERS` (BYOK vision + nano).

### 6. Ladder builders — `src/engine.ts` `buildLadder` (~L250) & `src/extension/lite-engine.ts` `buildLiteLadder` (~L77)
- Both compute **two** pins from settings: `navigatorName` (from `settings.navigator`) and `plannerName` (from `settings.planner`), and pass both to `new ModelRouter(adapters, { navigatorAdapter, plannerAdapter, preferFreePlanner })`.
- Lite: navigator may be `nano` → include the Nano adapter as a `plan-step` provider (Phase A) in addition to the visual rung.
- Daemon: unchanged rungs, just the second pin.

### 7. Nano-as-navigator (Phase A, spike-gated) — `src/router/adapters/nano.ts`, `src/ports/nano-port.ts`, runner assets, `src/extension/lite-nano.ts` (+ `sw.js` offscreen plumbing)
- `NanoPort` gains a `navStep(prompt, schema)` method (Prompt API structured output over the a11y text — same JSON-constraint mechanism Spike A proved for verdicts; text-only, no image needed to pick a nodeId).
- `NanoAdapter.supports('plan-step')` → true once `navStep` exists; still throws for `plan-goals`.
- Lite: extend `LiteNanoDeps` with `navStep`; wire it in `sw.js` via the existing offscreen/runner plumbing.
- **Spike first** (`spikes/nano-nav/`): can Nano reliably pick a correct action from a real a11y tree + sub-goal on `https://mapleandsand.com/` and the fixture? Exit criteria: ≥N correct single-step picks, latency acceptable. **If it fails**, Nano-navigator ships behind an "Experimental (free, may be unreliable)" label and the default navigator falls back to a cheap cloud model — the rest of the plan is unaffected.

### 8. Cost accounting — `src/driver/loop.ts` `computeTokens` + `src/report/report.ts`
- `model_trace` already carries `capability`; extend `ReportTokens` with per-role splits: `{ navigatorTokens, brainTokens, visualCalls, brainCalls, navigatorCalls, ... }` derived by grouping the trace on `capability`.
- Surface in the plain report / panel: e.g. "42 navigator steps (cheap) · 2 brain calls · verdict payload ~1.8K tok" — the proof of the cost win.

### 9. UI — `extension/panel.html`, `panel.js`, `panel.css`, `extension/sw.js`
- **Two Settings cards** (duplicate the existing `.settings-group` block, generic CSS classes already support it):
  - **Card 1 "Navigator — does each step (cheap)":** provider select incl. Nano; model; key row (per provider). Copy: "The fast, cheap model that clicks, types, and looks at the page every step."
  - **Card 2 "Brain — makes the plan (smart)":** provider select excl. Nano; model; key row. Copy: "The smarter model, called only to plan and when the navigator gets stuck — so it barely affects cost."
- Config protocol (panel ↔ sw.js): `config-get`/`config-set` payloads carry BOTH `planner` and `navigator`; `renderSettings`/`refreshSettingsVisibility` handle both cards; per-card `selectedProvider/mode/model`. Keys stay keyed by provider in `spikeKeys` (two cards sharing a provider share the key). `runLiteFromPanel` passes both selections; validate BOTH required keys are present (nano needs none).
- Daemon parity: `src/vibe/service.ts` `vibe.config.get/set` + `src/config.ts` (`SPIKE_NAVIGATOR_*` env) + `SettingsStore` handle the `navigator` field; `buildLiteConfig` in lite-engine adds it too.

## Files
**Modify:** `src/router/adapter.ts`, `src/router/model-router.ts`, `src/driver/loop.ts`, `src/driver/actions.ts`, `src/driver/planner-prompt.ts`, `src/vibe/settings-data.ts`, `src/vibe/settings.ts`, `src/vibe/service.ts`, `src/config.ts`, `src/engine.ts`, `src/extension/lite-engine.ts`, `src/report/report.ts`, `extension/sw.js`, `extension/panel.html`, `extension/panel.js`, `extension/panel.css`.
**Nano-nav (Phase A):** `src/router/adapters/nano.ts`, `src/ports/nano-port.ts`, the runner-assets, `src/extension/lite-nano.ts`.
**Create:** `spikes/nano-nav/` (spike), possibly `src/driver/goal-planner-prompt.ts` (or extend `planner-prompt.ts`).

## Phasing
- **Phase A — Nano-nav spike (GO/NO-GO):** prove Nano can pick actions; decides whether Nano-navigator is a real default or an experimental toggle. Everything else proceeds regardless.
- **Phase B — Router + capability + prompts + actions:** `plan-goals` capability, two pins, `planGoals`, goal/navigator prompts + schemas. Unit-testable without the UI.
- **Phase C — Loop rewrite:** hierarchical loop with escalate-on-stuck; keep all existing guards/evidence; raise `maxSteps`.
- **Phase D — Settings data + both ladder builders + daemon/lite config wiring.**
- **Phase E — Nano action-picker adapter** (if Phase A GO) in daemon + lite.
- **Phase F — Two-card Settings UI + sw.js protocol.**
- **Phase G — Cost accounting split + plain-report/panel surfacing.**

## Verification
- `npm run typecheck` + `npm run build` (both tsup targets) clean; grep-gate the lite bundle for `require(`/`node:`.
- `npm run test:e2e` (fixture, both bug modes) still passes end-to-end.
- **Cost proof:** run the dogfood task on `https://mapleandsand.com/` and the fixture; confirm `model_trace` shows **1–few brain calls** vs **many navigator calls**, and `report.tokens` per-role split reflects it — brain calls must NOT scale with step count.
- **Robustness:** force a stuck state (e.g. a goal the navigator can't satisfy) → confirm exactly one brain escalation re-plans and the run recovers or fails honestly.
- **Lite UI:** in the extension with only pasted keys, set Navigator=Gemini Flash + Brain=Claude Sonnet (or Nano navigator if Phase A GO), run against mapleandsand.com → live feed, correct verdict, per-role cost shown, graceful "add your Brain key" when the brain key is missing.
