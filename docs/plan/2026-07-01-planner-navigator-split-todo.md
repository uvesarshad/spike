# TODO — Planner / Navigator split

> **Date:** 2026-07-01 · **Updated:** 2026-07-01 (Phases B–G landed, static verification green)
> **Plan:** [2026-07-01-planner-navigator-split.md](./2026-07-01-planner-navigator-split.md)
> Built by fanning out 4 parallel agents on disjoint file sets against one shared contract; integrated + typechecked clean.

---

## Phase A — Nano-nav spike (GO/NO-GO)
- [x] Create `spikes/nano-nav/` spike: standalone Node+CDP harness feeding Nano `{task + sub-goal + a11y text}` with a single-action JSON schema (Prompt API `responseConstraint`, text-only). 6 login→cart→checkout cases + goal_complete/blocked detection; prints per-case pick-vs-expected + GO/NO-GO.
- [ ] **← USER RUNS:** `cd spikes/nano-nav && npm install && node spike-nano-nav.js` (needs your Chrome + on-device Nano). Result decides whether Nano navigator is the default or an "Experimental" toggle.

## Phase B — Router + capability + prompts + actions ✅
- [x] `adapter.ts`: `Capability` += `'plan-goals'`.
- [x] Adapters' `supports()`: every plan-step adapter also serves plan-goals (cli-planner fixed; nano untouched).
- [x] `actions.ts`: `GoalPlanSchema`/`GOAL_PLAN_JSON_SCHEMA`; `PlanResult` += optional `goalComplete`/`blocked` (refined).
- [x] `planner-prompt.ts`: `buildGoalPlannerPrompt` + `buildNavigatorPrompt`.
- [x] `model-router.ts`: `navigatorAdapter`/`plannerAdapter` pins + `planGoals()` (shared `planWith`); pin-aware `candidates`/`pinRank`.

## Phase C — Driver loop rewrite ✅
- [x] Initial brain `planGoals` → goals; navigator inner loop with `currentGoal`; `goalComplete`/`blocked` handling.
- [x] Escalate-on-stuck triggers (blocked, 3× loop→escalate-first, invalid JSON, per-goal overflow, finish-confirm disagreement); `MAX_BRAIN_ESCALATIONS` guard.
- [x] Finish/verdict (navigator + Nano confirm, brain on disagreement); `maxSteps` raised to 40 + per-goal budget.
- [x] **Integration add:** graceful **navigator-only fallback** — when no `plan-goals` adapter is configured (single-model setups, and the scripted tests), run one implicit goal = the task, escalate ends honestly. `router.hasCapability()` added.
- [x] All existing machinery preserved (execute/retry, batching, drains, secrets, read-only guard, audit, onStep, evidence).

## Phase D — Settings data + ladders + config ✅
- [x] `settings-data.ts`: `QaSettings.navigator`; `DEFAULT_SETTINGS` (nav=nano/ondevice, brain=claude/api); role-aware `defaultModelFor`; `LITE_NAVIGATOR_PROVIDERS`; `PlannerMode` += `'ondevice'`.
- [x] `settings.ts` migration merge; `config.ts` `QA_NAVIGATOR_*` env + load; `service.ts` config get/set carry navigator + per-provider nav/brain defaults.
- [x] `engine.ts` `buildLadder` + `lite-engine.ts` `buildLiteLadder`/`runLite`/`buildLiteConfig`: two pins (navigatorAdapter/plannerAdapter).

## Phase E — Nano action-picker adapter ✅
- [x] `nano-port.ts`: `navStep(prompt, schema)` added to interface; `runner-assets.ts` navStep (Prompt API `responseConstraint`, text-only); daemon `nano-runner-page.ts` + bridge `extension-nano.ts` navStep.
- [x] `nano.ts`: `supports('plan-step')` true (visual+plan-step); `generateJson` branches on image; still refuses plan-goals.
- [x] `lite-nano.ts`: `LiteNanoDeps.navStep` + `LiteNano.navStep`; wired in `sw.js` (`nanoNavStep` SW-direct/offscreen, `liteNanoDeps.navStep`, bridge `nano.navStep` case) + `nano-offscreen.js` navStep op.
- [x] Ladder fallback: `NanoAdapter` already added to both ladders when available → `navigator=nano` engages Nano; when unavailable the router falls to a cloud navigator. Default nav = Nano (pending Phase A spike to confirm reliability; downgrade to "Experimental" if NO-GO).

## Phase F — Two-card Settings UI ✅
- [x] `panel.html`: Navigator card (incl. Nano, `setNav*` ids) above Brain card (excl. Nano); role copy.
- [x] `panel.css` `.settings-group-sub`; `panel.js` per-card selectors/render/visibility, config-set sends both roles.
- [x] `sw.js`: per-role key validation (explicit add-Brain-key / add-Navigator-key prompts), passes both selections to `runLite`.

## Phase G — Per-role cost accounting ✅
- [x] `report.ts` `ReportTokens` += navigator/brain/visual calls + tokens.
- [x] `loop.ts` `computeTokens` groups trace by capability; `fix-prompt.ts` `renderPlainReport` shows "N navigator steps · M brain calls · verdict payload ~X tok".

---

## Verification
- [x] `npm run typecheck` — clean.
- [x] `npm run build` — both tsup targets build; lite bundle grep-gate clean (0 `node:`; only `require(` is esbuild's `__require` helper).
- [x] Unit tests: v13 tier4 (32/32), v20 tokens incl. per-role (17/17), v25 providers+pinning (26/26), m4 router (7/7 relevant). *m4 crashes at the end on the pre-existing dead-gemini-CLI spawn — not a regression.*
- [ ] **Live (needs a working planner + Chrome):** `npm run test:e2e` fixture both bug modes.
- [ ] **Cost proof:** dogfood on `https://mapleandsand.com/` + fixture → few brain calls vs many navigator calls; brain calls don't scale with step count.
- [ ] **Robustness:** force a stuck goal → one brain escalation re-plans; recovers or fails honestly.
- [ ] **Lite UI:** only pasted keys, Navigator=Gemini Flash + Brain=Claude Sonnet → live feed, correct verdict, per-role cost shown, graceful missing-brain-key prompt.
