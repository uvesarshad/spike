# Token-Cost Benchmark: What Does One Browser QA Test Cost Your Coding Agent?

*Measured 2026-06-07 on a real end-to-end run. Methodology and caveats below.*

## The headline

| Approach | Tokens the **coding agent** pays per test | Who does the looking |
|---|---:|---|
| **Playwright MCP** driven by the coding agent | **~114,000** | the frontier model reads every screenshot/snapshot itself |
| Playwright CLI (token-optimized) | ~27,000 | same — still the expensive model |
| **This project (`qa_run`)** | **84** *(measured)* | a $0/free cheap-model ladder; the agent reads only the verdict |

**~1,350× less** of the expensive model's context per test — and the agent's context stays clean for what it's actually good at: writing the fix.

## The measured run

One complete QA test against the demo shop: *"Log in, add the Widget to the cart, check out, place the order, verify the confirmation page."* 8 driver steps (2 typed fields, 5 clicks, 1 visual confirmation), verdict `pass`.

| Metric | Value |
|---|---:|
| Tokens returned to the calling agent (`verdict + failing_step + console_error + evidence_paths + reason`) | **84** |
| Cheap-model calls (Gemini 3 Flash, free CLI quota) | 6 (5 planning + 1 visual confirm) |
| Cheap-model tokens total | 74,924 |
| …of which served from cache | 54,560 (73%) |
| Cheap-model cost | **$0.00** (free quota; BYOK Flash pricing would be ≈ $0.01) |
| On-device Gemini Nano calls | 0 in this run (model not present on the throwaway profile; when available, visual checks move to Nano at $0 and ~2-5s) |
| Engine time | 95s (planner CLI latency dominates; BYOK halves it) |

Per-call trace (from `report.model_trace` — every run records this):

| step | capability | adapter | ms | prompt tok | output tok | cached |
|---|---|---|---:|---:|---:|---:|
| 0 | plan | gemini CLI | 15,539 | 18,157 | 146 | 11,665 |
| 3 | plan | gemini CLI | 14,359 | 18,375 | 136 | 11,686 |
| 5 | plan | gemini CLI | 12,980 | 9,084 | 172 | 7,802 |
| 6 | plan | gemini CLI | 13,165 | 9,060 | 214 | 7,801 |
| 7 | plan | gemini CLI | 11,643 | 9,060 | 42 | 7,801 |
| 7 | visual confirm | gemini CLI | 20,721 | 9,203 | 1,275 | 7,805 |

## Why the gap is structural, not an optimization

- **Playwright MCP**: the coding agent itself drives the browser. Every page snapshot (~thousands of tokens) and screenshot (10K+ tokens) lands in the *frontier model's* context, at frontier prices, crowding out the code it's supposed to be fixing. The ~114K/test figure is from published measurements (scrolltest.medium.com "The Context Wars"; see also paddo.dev, betterstack.com on MCP vs CLI token costs).
- **This project**: the coding agent calls one tool and reads one verdict. The browser-driving happens in a separate process where pages are read as compact accessibility trees (~800 tokens) by a Flash-class model, and visual judgments go to an on-device model when available. The expensive context never sees a screenshot.

## Methodology

- One run of `test/v20b.measure.ts`: fully isolated Chrome (throwaway profile, dedicated ports), healthy fixture shop, `gemini-3-flash-preview` via the gemini CLI free tier, no Nano (cold profile), clip recording off.
- Token counts are **exact**, not estimated: the gemini CLI's `-o json` envelope reports per-call `{input, prompt, candidates, total, cached}`; the BYOK adapter reads `usageMetadata` the same way. The 84-token verdict payload is `ceil(chars/4)` of the actual JSON the MCP tool returns.
- Reproduce: `npx tsx test/v20b.measure.ts` (any machine with the gemini CLI logged in).

## Honest caveats

- Per-app variance is real: bigger pages → bigger a11y trees → more planner tokens (the cheap side scales; the 84-token verdict side doesn't).
- The free CLI quota is a default, not a foundation (Google's terms shift 2026-06-18); BYOK Flash at current pricing puts the cheap side around a cent per test, and Ollama is the $0 floor.
- Latency: ~13-20s per planner call on the free CLI (process spawn + auth dominate). BYOK HTTP planning is several times faster. Replays of recorded runs skip the planner entirely (~9s, $0).
- The comparison run used zero Nano calls; machines with the on-device model shift visual checks to $0/faster.
