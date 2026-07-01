// src/extension/buffer-shim.ts
import { Buffer } from "buffer";

// src/router/verdict.ts
var VERDICT_JSON_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "issues"],
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "fail", "uncertain"] },
    summary: { type: "string" },
    issues: { type: "array", items: { type: "string" } }
  }
};
function verdictPrompt(expectation) {
  return `You are a QA assistant inspecting a screenshot of a web page.
Question: ${expectation}
Judge strictly from what is visible. List concrete issues if any.
Respond with ONLY a JSON object: {"verdict":"pass"|"fail"|"uncertain","summary":string,"issues":string[]}`;
}

// src/router/model-router.ts
var ModelRouter = class {
  constructor(adapters, opts) {
    this.adapters = adapters;
    this.adapters = [...adapters].sort((a, b) => a.rung - b.rung);
    this.preferFreePlanner = opts?.preferFreePlanner ?? false;
    this.pinnedAdapter = opts?.pinnedAdapter;
  }
  adapters;
  trace = [];
  preferFreePlanner;
  pinnedAdapter;
  async candidates(cap) {
    const supported = this.adapters.filter((a) => a.supports(cap));
    const ready = await Promise.all(supported.map((a) => a.available().catch(() => false)));
    const out = supported.filter((_, i) => ready[i]);
    if (this.pinnedAdapter && out.some((a) => a.name === this.pinnedAdapter)) {
      out.sort((a, b) => this.pinRank(a, cap) - this.pinRank(b, cap));
      return out;
    }
    if (cap === "plan-step" && !this.preferFreePlanner && out.some((a) => a.rung === 2)) {
      out.sort((a, b) => planRank(a.rung) - planRank(b.rung));
    }
    return out;
  }
  /** Sort key when a pin is active: lower comes first. Nano keeps the visual lead;
   * the pinned adapter leads otherwise; everyone else stays in rung order behind. */
  pinRank(a, cap) {
    if (cap === "visual-verdict" && a.rung === 0) return -2;
    if (a.name === this.pinnedAdapter) return -1;
    return a.rung;
  }
  /** Visual assertion: rung 0 first; an `uncertain` verdict escalates to the next rung. */
  async visualVerdict(png, expectation, step) {
    const ladder = await this.candidates("visual-verdict");
    if (ladder.length === 0) throw new Error("no visual-verdict adapter available");
    let lastError = null;
    let escalatedFrom;
    let lastUncertain = null;
    for (const adapter of ladder) {
      const t0 = Date.now();
      try {
        const prompt = adapter.rung === 0 ? expectation : verdictPrompt(expectation);
        const raw = await adapter.generateJson({
          prompt,
          schema: VERDICT_JSON_SCHEMA,
          imagePng: png
        });
        const verdict = {
          verdict: raw.verdict === "pass" || raw.verdict === "fail" ? raw.verdict : "uncertain",
          summary: raw.summary ?? "",
          issues: Array.isArray(raw.issues) ? raw.issues : []
        };
        this.trace.push({
          step,
          capability: "visual-verdict",
          rung: adapter.rung,
          adapter: adapter.name,
          ms: Date.now() - t0,
          escalatedFrom,
          note: verdict.verdict === "uncertain" ? "uncertain \u2192 escalate" : void 0,
          usage: adapter.lastUsage
        });
        if (verdict.verdict !== "uncertain") return verdict;
        lastUncertain = verdict;
        escalatedFrom = adapter.name;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        this.trace.push({
          step,
          capability: "visual-verdict",
          rung: adapter.rung,
          adapter: adapter.name,
          ms: Date.now() - t0,
          escalatedFrom,
          note: `error \u2192 escalate: ${lastError.message.slice(0, 120)}`
        });
        escalatedFrom = adapter.name;
      }
    }
    if (lastUncertain) return lastUncertain;
    throw new Error(`all visual-verdict adapters failed: ${lastError?.message}`);
  }
  /** Planning: rung 1 by default (rung 0 never plans); falls down-ladder on errors. */
  async planJson(prompt, schema, step) {
    const ladder = await this.candidates("plan-step");
    if (ladder.length === 0) {
      throw new Error(
        "no planner available \u2014 install the Google CLI (free quota) or set GEMINI_API_KEY (BYOK)"
      );
    }
    let lastError = null;
    let escalatedFrom;
    for (const adapter of ladder) {
      const t0 = Date.now();
      try {
        const result = await adapter.generateJson({ prompt, schema });
        this.trace.push({
          step,
          capability: "plan-step",
          rung: adapter.rung,
          adapter: adapter.name,
          ms: Date.now() - t0,
          escalatedFrom,
          usage: adapter.lastUsage
        });
        return result;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        this.trace.push({
          step,
          capability: "plan-step",
          rung: adapter.rung,
          adapter: adapter.name,
          ms: Date.now() - t0,
          escalatedFrom,
          note: `error \u2192 escalate: ${lastError.message.slice(0, 120)}`
        });
        escalatedFrom = adapter.name;
      }
    }
    throw new Error(`all planner adapters failed: ${lastError?.message}`);
  }
};
function planRank(rung) {
  if (rung === 2) return 0;
  if (rung === 1) return 1;
  if (rung === 3) return 2;
  return 3 + rung;
}

// src/capture/console-network.ts
async function attachCapture(client) {
  let consoleBuf = [];
  let networkBuf = [];
  const pending = /* @__PURE__ */ new Map();
  await client.Network.enable({});
  client.Runtime.consoleAPICalled(({ type, args }) => {
    consoleBuf.push({
      ts: Date.now(),
      level: type,
      text: args.map((a) => a.value ?? a.description ?? "").join(" ")
    });
  });
  client.Runtime.exceptionThrown(({ exceptionDetails }) => {
    const desc = exceptionDetails.exception?.description ?? exceptionDetails.text ?? "unknown page error";
    consoleBuf.push({ ts: Date.now(), level: "page-error", text: `[PAGE-ERROR] ${desc}` });
  });
  client.Network.requestWillBeSent(({ requestId, request }) => {
    pending.set(requestId, { ts: Date.now(), method: request.method, url: request.url });
  });
  client.Network.responseReceived(({ requestId, response }) => {
    const req = pending.get(requestId);
    if (!req) return;
    pending.delete(requestId);
    networkBuf.push({
      ts: req.ts,
      method: req.method,
      url: req.url,
      status: response.status,
      ms: Date.now() - req.ts,
      failed: response.status >= 500
    });
  });
  client.Network.loadingFailed(({ requestId, errorText }) => {
    const req = pending.get(requestId);
    if (!req) return;
    pending.delete(requestId);
    networkBuf.push({
      ts: req.ts,
      method: req.method,
      url: req.url,
      ms: Date.now() - req.ts,
      failed: true,
      errorText
    });
  });
  return {
    drainConsole() {
      const out = consoleBuf;
      consoleBuf = [];
      return out;
    },
    drainNetwork() {
      const out = networkBuf;
      networkBuf = [];
      return out;
    }
  };
}
function firstError(console_, network) {
  const pageError = console_.find((e) => e.level === "page-error");
  if (pageError) return pageError.text;
  const consoleError = console_.find((e) => e.level === "error");
  if (consoleError) return consoleError.text;
  const netFail = network.find((e) => e.failed);
  if (netFail) {
    return `[NET-FAIL] ${netFail.method} ${netFail.url} \u2192 ${netFail.status ?? netFail.errorText ?? "failed"}`;
  }
  return void 0;
}

// src/report/report.ts
function slimReport(r) {
  return {
    verdict: r.verdict,
    failing_step: r.failing_step,
    console_error: r.console_error,
    evidence_paths: r.evidence_paths,
    reason: r.reason
  };
}
function describeAction(a) {
  switch (a.type) {
    case "navigate":
      return `navigate to ${a.url}`;
    case "click":
      return `click ${a.nodeId}`;
    case "type":
      return `type ${JSON.stringify(a.text)} into ${a.nodeId}`;
    case "assert_visual":
      return `visual check: ${a.expectation}`;
    case "assert_dom":
      return `dom check: ${a.nodeId} contains ${JSON.stringify(a.contains)}`;
    case "wait":
      return `wait ${a.ms}ms`;
    case "finish":
      return `finish: ${a.verdict} \u2014 ${a.reason}`;
  }
}

// src/driver/actions.ts
import { z } from "zod";
var ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string() }),
  z.object({ type: z.literal("click"), nodeId: z.string() }),
  z.object({ type: z.literal("type"), nodeId: z.string(), text: z.string() }),
  z.object({ type: z.literal("assert_visual"), expectation: z.string() }),
  z.object({ type: z.literal("assert_dom"), nodeId: z.string(), contains: z.string() }),
  z.object({ type: z.literal("wait"), ms: z.number().int().min(50).max(1e4) }),
  z.object({
    type: z.literal("finish"),
    verdict: z.enum(["pass", "fail"]),
    reason: z.string()
  })
]);
var PlanResultSchema = z.object({
  thought: z.string(),
  /** 1-3 actions; the loop may discard the tail of the batch (see loop.ts). */
  actions: z.array(ActionSchema).min(1).max(3)
});
var PLAN_JSON_SCHEMA = {
  type: "object",
  required: ["thought", "actions"],
  additionalProperties: false,
  properties: {
    thought: { type: "string", description: "one short sentence of reasoning" },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      description: "1-3 actions to run in sequence; only batch ones independent of each other",
      items: {
        type: "object",
        required: ["type"],
        properties: {
          type: {
            type: "string",
            enum: ["navigate", "click", "type", "assert_visual", "assert_dom", "wait", "finish"]
          },
          url: { type: "string" },
          nodeId: { type: "string" },
          text: { type: "string" },
          expectation: { type: "string" },
          contains: { type: "string" },
          ms: { type: "integer" },
          verdict: { type: "string", enum: ["pass", "fail"] },
          reason: { type: "string" }
        }
      }
    }
  }
};

// src/driver/planner-prompt.ts
var MAX_EVIDENCE_LINES = 8;
function consoleLines(entries) {
  return entries.filter((e) => e.level === "error" || e.level === "page-error" || e.level === "warn").slice(-MAX_EVIDENCE_LINES).map((e) => `console.${e.level}: ${e.text.slice(0, 200)}`);
}
function networkLines(entries) {
  return entries.filter((e) => e.failed).slice(-MAX_EVIDENCE_LINES).map((e) => `net: ${e.method} ${e.url} \u2192 ${e.status ?? e.errorText ?? "failed"}`);
}
function buildPlannerPrompt(ctx) {
  const historyLines = ctx.history.map((s) => {
    const bits = [`${s.index}. ${s.description} \u2192 ${s.ok ? "ok" : `FAILED: ${s.error ?? "unknown"}`}`];
    bits.push(...consoleLines(s.console).map((l) => `   ${l}`));
    bits.push(...networkLines(s.network).map((l) => `   ${l}`));
    if (s.visual) bits.push(`   visual verdict: ${s.visual.verdict} \u2014 ${s.visual.summary.slice(0, 150)}`);
    return bits.join("\n");
  });
  return `You are a browser QA agent. You control a real Chrome page one action at a time.

TASK: ${ctx.task}

CURRENT URL: ${ctx.url}
STEP: ${ctx.stepIndex + 1} of max ${ctx.maxSteps}

CURRENT PAGE (accessibility tree; nodeIds like n7 are what you reference in actions):
${ctx.axText}

${ctx.history.length ? `ACTIONS SO FAR (with any errors/console/network evidence they caused):
${historyLines.join("\n")}` : "No actions taken yet."}

Decide the next 1-3 actions. Rules:
- Interact via nodeIds from the tree above (click/type). nodeIds change every step \u2014 only use ids from THIS tree.
- typing into a field REPLACES its content; no need to clear first.
- Use assert_dom (free) to check visible text; use assert_visual ONLY when correctness must be judged from how the page looks (layout, error banners, missing content).
- Console errors / failed network requests after an action are strong evidence the app is broken \u2014 investigate or finish with verdict "fail" and cite them.
- If the page shows an error message after your action (e.g. "Invalid email or password"), do NOT retry the same input \u2014 the input is wrong. finish with verdict "fail" and quote the visible error so the user can correct their task.
- When the task is demonstrably complete, action finish with verdict "pass". If the app is broken such that the task cannot complete, finish with verdict "fail" and a precise reason.
- Do not repeat an action that already failed twice.
- If the task references a stored secret like {{secret:NAME}}, pass that placeholder VERBATIM as the text of a type action \u2014 never invent its value.

BATCHING: PREFER returning 2-3 actions when you are confident they are independent of each other's outcomes \u2014 this is much faster. The actions run in order against THIS tree. Examples:
- fill several fields then click submit: [type email, type password, click "Sign in"].
- act on the page then move on: [click "Add Widget to cart", click "Go to cart"] \u2014 the add-to-cart click updates the page in place; the navigating click goes LAST.
Rules:
- After any action that navigates or could meaningfully change the page (a click that submits a form or navigates, or a navigate action), the remaining actions in your batch are DISCARDED and you will be asked again with the new page. So the ONLY navigating/submitting action in a batch must be the LAST one; everything before it must keep you on the same page.
- finish, assert_visual and assert_dom must be the ONLY action in their batch (return exactly one action).
- When unsure whether an earlier action changes the page, return a single action.

Action types:
- {"type":"navigate","url":string}
- {"type":"click","nodeId":string}
- {"type":"type","nodeId":string,"text":string}
- {"type":"assert_dom","nodeId":string,"contains":string}   // cheap text check
- {"type":"assert_visual","expectation":string}             // screenshot judged by a vision model
- {"type":"wait","ms":number}
- {"type":"finish","verdict":"pass"|"fail","reason":string}

Respond with ONLY JSON: {"thought": "<one short sentence>", "actions": [{...}, ...]}
Example: {"thought":"Fill the login form and submit it.","actions":[{"type":"type","nodeId":"n4","text":"test@test.com"},{"type":"type","nodeId":"n6","text":"pw"},{"type":"click","nodeId":"n8"}]}`;
}

// src/driver/loop.ts
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var SECRET_RE = /\{\{secret:([a-zA-Z0-9_-]+)\}\}/g;
var SecretNotFoundError = class extends Error {
};
function resolveSecrets(text, vault) {
  if (!SECRET_RE.test(text)) return text;
  SECRET_RE.lastIndex = 0;
  return text.replace(SECRET_RE, (_m, name) => {
    const value = vault?.get(name);
    if (value === void 0) {
      throw new SecretNotFoundError(
        `secret "${name}" not found \u2014 add it with: qa secret set ${name}`
      );
    }
    return value;
  });
}
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
function hostAllowed(host, allowedHosts) {
  return allowedHosts.some((allowed) => {
    const a = allowed.toLowerCase();
    return host === a || host.endsWith("." + a);
  });
}
function stepKind(action) {
  switch (action.type) {
    case "click":
      return "click";
    case "type":
      return "type";
    case "navigate":
      return "navigate";
    case "wait":
      return "wait";
    case "finish":
      return "finish";
    case "assert_visual":
    case "assert_dom":
      return "assert";
  }
}
function humanizeAction(action, target) {
  const tgt = target ? target.name ? `${target.role} "${target.name}"` : target.role : void 0;
  switch (action.type) {
    case "click":
      return `Click ${tgt ?? action.nodeId}`;
    case "type":
      return `Type into ${tgt ?? action.nodeId}`;
    case "navigate":
      return `Navigate to ${action.url}`;
    case "wait":
      return `Wait ${action.ms}ms`;
    case "finish":
      return `Finish: ${action.verdict} \u2014 ${action.reason}`;
    case "assert_visual":
      return `Visual check: ${action.expectation}`;
    case "assert_dom":
      return `Check ${tgt ?? action.nodeId} contains "${action.contains}"`;
  }
}
function drainHasPageError(consoleEntries, networkEntries) {
  return consoleEntries.some((e) => e.level === "error" || e.level === "page-error") || networkEntries.some((e) => e.failed);
}
function visibleErrorText(axText) {
  if (!axText) return null;
  let fallback = null;
  for (const line of axText.split("\n")) {
    const lower = line.toLowerCase();
    if (!lower.includes("error") && !lower.includes("invalid")) continue;
    const quoted = line.match(/"([^"]+)"/);
    const text = (quoted ? quoted[1] : line.trim()).trim();
    if (!text) continue;
    if (lower.includes("alert") || lower.includes("statictext")) return text;
    fallback ??= text;
  }
  return fallback;
}
async function runDriverLoop(browser, router, artifacts, task, url, opts) {
  const t0 = Date.now();
  const steps = [];
  let verdict = "uncertain";
  let reason = "step budget exhausted before the task completed";
  let failingStep = null;
  const onStep = opts.onStep ?? (() => {
  });
  const allowedHosts = opts.allowedHosts ?? ["localhost", "127.0.0.1"];
  const vault = opts.vault;
  const signal = opts.signal;
  await browser.navigate(url);
  browser.drainConsole();
  browser.drainNetwork();
  let stepIndex = 0;
  let lastBatchFirstSig = null;
  let lastSnapshotAx = null;
  let done = false;
  while (stepIndex < opts.maxSteps && !done) {
    if (signal?.aborted) {
      reason = "cancelled by user";
      break;
    }
    const ax = await browser.axTree();
    lastSnapshotAx = ax;
    const batchUrl = await browser.url();
    onStep({ index: stepIndex, kind: "plan", text: "Planning next step\u2026" });
    let plan;
    try {
      plan = await planOnce(router, {
        prompt: buildPlannerPrompt({
          task,
          url: batchUrl,
          axText: ax.text,
          history: steps,
          stepIndex,
          maxSteps: opts.maxSteps
        }),
        step: stepIndex
      });
    } catch (e) {
      reason = `planner failed: ${e instanceof Error ? e.message : e}`;
      break;
    }
    let actions = plan.actions;
    if (actions[0].type === "finish" || actions[0].type === "assert_visual" || actions[0].type === "assert_dom") {
      actions = [actions[0]];
    }
    const firstSig = actions.length === 1 ? JSON.stringify(actions[0]) : null;
    if (firstSig !== null && firstSig === lastBatchFirstSig && steps.length >= 2 && JSON.stringify(steps[steps.length - 1].action) === firstSig && JSON.stringify(steps[steps.length - 2].action) === firstSig) {
      const visibleErr = visibleErrorText(lastSnapshotAx?.text);
      reason = `planner repeated the same action 3\xD7: ${describeAction(actions[0])}` + (visibleErr ? ` \u2014 page shows: "${visibleErr}" (likely the real cause)` : "");
      break;
    }
    lastBatchFirstSig = firstSig;
    let aborted = false;
    let readOnlyBlock = null;
    for (let a = 0; a < actions.length && stepIndex < opts.maxSteps; a++) {
      const action = actions[a];
      if (signal?.aborted) {
        aborted = true;
        reason = "cancelled by user";
        break;
      }
      if (action.type === "click" || action.type === "type") {
        const host = hostOf(await browser.url());
        if (host && !hostAllowed(host, allowedHosts)) {
          readOnlyBlock = host;
          break;
        }
      }
      const i = stepIndex++;
      const record = {
        index: i,
        thought: a === 0 ? plan.thought : void 0,
        action,
        description: describeAction(action),
        ok: true,
        console: [],
        network: [],
        ts: Date.now()
      };
      if ("nodeId" in action) {
        const t = findNode(ax.root, action.nodeId);
        if (t) {
          record.target = { role: t.role, ...t.name && { name: t.name } };
          const { count, index } = rankByRoleName(ax.root, t.role, t.name, action.nodeId);
          if (count > 1 && index >= 0) record.target.nth = index;
          if (!t.name && (action.type === "click" || action.type === "type") && browser.stampQaId) {
            try {
              const qaId = await browser.stampQaId(action.nodeId);
              if (qaId) record.target.qaId = qaId;
            } catch {
            }
          }
        }
      }
      steps.push(record);
      try {
        if (action.type === "finish") {
          if (action.verdict === "fail") {
            verdict = "fail";
            reason = action.reason;
            failingStep = lastInteraction(steps) ?? { index: i, action, description: record.description };
          } else {
            const png = await browser.screenshot();
            record.screenshot = artifacts.saveScreenshot(i, png);
            const confirm = await router.visualVerdict(
              png,
              `The task "${task}" should have completed successfully. Does the page show a sensible end state for it (no error banners, no blank page)?`,
              i
            );
            record.visual = confirm;
            if (confirm.verdict === "fail") {
              verdict = "fail";
              reason = `planner claimed success but the confirmation visual check failed: ${confirm.summary}`;
              failingStep = { index: i, action, description: record.description };
            } else {
              verdict = "pass";
              reason = action.reason;
            }
          }
        } else if (action.type === "assert_visual") {
          const png = await browser.screenshot();
          record.screenshot = artifacts.saveScreenshot(i, png);
          const v = await router.visualVerdict(png, action.expectation, i);
          record.visual = v;
          if (v.verdict === "fail") {
            verdict = "fail";
            reason = `visual assertion failed: ${v.summary}${v.issues.length ? ` \u2014 ${v.issues.join("; ")}` : ""}`;
            failingStep = { index: i, action, description: record.description };
          }
        } else if (action.type === "assert_dom") {
          const t = findNode(ax.root, action.nodeId);
          const hay = t ? subtreeText(t) : "";
          if (!t) {
            record.ok = false;
            record.error = `nodeId ${action.nodeId} not in current tree`;
          } else if (!hay.toLowerCase().includes(action.contains.toLowerCase())) {
            record.ok = false;
            record.error = `expected ${JSON.stringify(action.contains)} in ${action.nodeId}, found: ${hay.slice(0, 150)}`;
          }
        } else if (action.type === "type") {
          const resolved = resolveSecrets(action.text, vault);
          await executeWithRetry(browser, { ...action, text: resolved }, ax.root);
        } else {
          await executeWithRetry(browser, action, ax.root);
        }
      } catch (e) {
        record.ok = false;
        record.error = e instanceof Error ? e.message : String(e);
      }
      await sleep(150);
      record.console = browser.drainConsole();
      record.network = browser.drainNetwork();
      artifacts.appendAudit({
        ts: record.ts,
        runId: artifacts.runId,
        action: action.type,
        target: auditTarget(action, record.target),
        url: await browser.url(),
        ok: record.ok
      });
      onStep({
        index: i,
        kind: stepKind(action),
        text: humanizeAction(action, record.target),
        ok: record.ok
      });
      if (verdict !== "uncertain" || action.type === "finish") {
        done = true;
        break;
      }
      if (a < actions.length - 1) {
        if (!record.ok) break;
        if (drainHasPageError(record.console, record.network)) break;
        const nowUrl = await browser.url();
        if (nowUrl !== batchUrl) break;
      }
    }
    if (aborted) {
      break;
    }
    if (readOnlyBlock) {
      verdict = "uncertain";
      reason = `read-only mode: ${readOnlyBlock} is not in allowedHosts \u2014 add it via QA_ALLOWED_HOSTS or qa.config.json to allow interaction`;
      break;
    }
  }
  const lastStep = steps[steps.length - 1];
  if (lastStep && !lastStep.screenshot) {
    try {
      const png = await browser.screenshot();
      lastStep.screenshot = artifacts.saveScreenshot(lastStep.index, png);
    } catch {
    }
  }
  if (verdict === "fail" && !failingStep && lastStep) {
    failingStep = { index: lastStep.index, action: lastStep.action, description: lastStep.description };
  }
  let consoleError = null;
  const scanOrder = failingStep ? [...steps.slice(0, failingStep.index + 1)].reverse() : [...steps].reverse();
  for (const s of scanOrder) {
    const err = firstError(s.console, s.network);
    if (err) {
      consoleError = err;
      break;
    }
  }
  const report = {
    verdict,
    failing_step: failingStep,
    console_error: consoleError,
    evidence_paths: [],
    reason,
    runId: artifacts.runId,
    task,
    url,
    steps,
    model_trace: router.trace,
    durationMs: Date.now() - t0,
    tokenEstimate: 0,
    tokens: { cheapModelTotal: 0, cheapModelCached: 0, callsByRung: {}, verdictPayloadTokens: 0 }
  };
  report.evidence_paths = [
    ...steps.filter((s) => s.screenshot).map((s) => s.screenshot)
  ];
  const reportPath = artifacts.saveReport(report);
  report.evidence_paths.unshift(reportPath);
  const tokens = computeTokens(report);
  report.tokens = tokens;
  report.tokenEstimate = tokens.verdictPayloadTokens;
  artifacts.saveReport(report);
  return report;
}
function slimForEstimate(r) {
  return {
    verdict: r.verdict,
    failing_step: r.failing_step,
    console_error: r.console_error,
    evidence_paths: r.evidence_paths,
    reason: r.reason
  };
}
function computeTokens(r) {
  let cheapModelTotal = 0;
  let cheapModelCached = 0;
  const callsByRung = {};
  for (const t of r.model_trace) {
    callsByRung[t.rung] = (callsByRung[t.rung] ?? 0) + 1;
    if (t.usage?.totalTokens) cheapModelTotal += t.usage.totalTokens;
    if (t.usage?.cachedTokens) cheapModelCached += t.usage.cachedTokens;
  }
  const verdictPayloadTokens = Math.ceil(
    JSON.stringify(r.steps.length ? slimForEstimate(r) : {}).length / 4
  );
  return { cheapModelTotal, cheapModelCached, callsByRung, verdictPayloadTokens };
}
async function planOnce(router, { prompt, step }) {
  const raw = await router.planJson(prompt, PLAN_JSON_SCHEMA, step);
  const parsed = PlanResultSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const retryRaw = await router.planJson(
    `${prompt}

Your previous response was invalid: ${parsed.error.message.slice(0, 300)}
Respond again with ONLY valid JSON.`,
    PLAN_JSON_SCHEMA,
    step
  );
  const retry = PlanResultSchema.safeParse(retryRaw);
  if (retry.success) return retry.data;
  throw new Error(`planner returned invalid actions twice: ${retry.error.message.slice(0, 200)}`);
}
async function executeWithRetry(browser, action, planTree) {
  try {
    await executeOnce(browser, action);
  } catch (firstErr) {
    if (action.type !== "click" && action.type !== "type") throw firstErr;
    const target = findNode(planTree, action.nodeId);
    if (!target) throw firstErr;
    const fresh = await browser.axTree();
    const match = findByRoleName(fresh.root, target.role, target.name);
    if (!match) throw firstErr;
    await executeOnce(browser, { ...action, nodeId: match.id });
  }
}
async function executeOnce(browser, action) {
  switch (action.type) {
    case "navigate":
      return browser.navigate(action.url);
    case "click":
      return browser.click(action.nodeId);
    case "type":
      return browser.type(action.nodeId, action.text);
    case "wait":
      return sleep(action.ms);
    default:
      throw new Error(`executeOnce: unexpected action ${action.type}`);
  }
}
function findNode(root, id) {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return void 0;
}
function rankByRoleName(root, role, name, targetId) {
  let count = 0;
  let index = -1;
  const walk = (n) => {
    if (n.role === role && n.name === name) {
      if (n.id === targetId) index = count;
      count++;
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return { count, index };
}
function findByRoleName(root, role, name) {
  if (root.role === role && root.name === name) return root;
  for (const c of root.children ?? []) {
    const hit = findByRoleName(c, role, name);
    if (hit) return hit;
  }
  return void 0;
}
function subtreeText(node) {
  const parts = [];
  const walk = (n) => {
    if (n.name) parts.push(n.name);
    if (n.value) parts.push(n.value);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return parts.join(" ");
}
function auditTarget(action, target) {
  if (action.type === "navigate") return action.url;
  if (target) return target.name ? `${target.role} "${target.name}"` : target.role;
  return void 0;
}
function lastInteraction(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.action.type === "click" || s.action.type === "type" || s.action.type === "navigate") {
      return { index: s.index, action: s.action, description: s.description };
    }
  }
  return null;
}

// src/router/adapter.ts
function withSchemaInstruction(prompt, schema) {
  return `${prompt}

Respond with ONLY a JSON object matching this JSON schema:
${JSON.stringify(schema)}`;
}
function extractJson(text) {
  const direct = text.trim();
  try {
    return JSON.parse(direct);
  } catch {
  }
  const fence = direct.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
    }
  }
  const start = direct.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < direct.length; i++) {
      if (direct[i] === "{") depth++;
      else if (direct[i] === "}" && --depth === 0) {
        try {
          return JSON.parse(direct.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error(`model output contained no parseable JSON: ${direct.slice(0, 200)}`);
}

// src/router/adapters/anthropic.ts
var AnthropicAdapter = class {
  constructor(opts) {
    this.opts = opts;
    this.name = `anthropic(${opts.model})`;
  }
  opts;
  name;
  rung = 2;
  lastUsage;
  async available() {
    return Boolean(this.opts.apiKey);
  }
  supports(_cap) {
    return true;
  }
  async generateJson(req) {
    if (!this.opts.apiKey) throw new Error("anthropic: no API key configured");
    this.lastUsage = void 0;
    const content = [];
    if (req.imagePng) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: req.imagePng.toString("base64") }
      });
    }
    content.push({ type: "text", text: withSchemaInstruction(req.prompt, req.schema) });
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
        ...this.opts.browserDirect ? { "anthropic-dangerous-direct-browser-access": "true" } : {}
      },
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: 4096,
        messages: [{ role: "user", content }]
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 12e4)
    });
    if (!res.ok) {
      throw new Error(`anthropic api ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const body = await res.json();
    const u = body.usage;
    if (u) {
      const usage = {};
      if (typeof u.input_tokens === "number") usage.promptTokens = u.input_tokens;
      if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
      if (usage.promptTokens !== void 0 && usage.outputTokens !== void 0) {
        usage.totalTokens = usage.promptTokens + usage.outputTokens;
      }
      if (Object.keys(usage).length) this.lastUsage = usage;
    }
    const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return extractJson(text);
  }
};

// src/router/adapters/openai-compatible.ts
var OpenAiCompatibleAdapter = class {
  constructor(opts) {
    this.opts = opts;
    this.name = `${opts.label}(${opts.model})`;
    this.supportsVision = opts.supportsVision ?? true;
  }
  opts;
  name;
  rung = 2;
  lastUsage;
  supportsVision;
  async available() {
    return Boolean(this.opts.apiKey);
  }
  supports(cap) {
    return cap === "visual-verdict" ? this.supportsVision : true;
  }
  async generateJson(req) {
    if (!this.opts.apiKey) throw new Error(`${this.opts.label}: no API key configured`);
    this.lastUsage = void 0;
    const userContent = [
      { type: "text", text: withSchemaInstruction(req.prompt, req.schema) }
    ];
    if (req.imagePng && this.supportsVision) {
      userContent.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${req.imagePng.toString("base64")}` }
      });
    }
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
        ...this.opts.extraHeaders ?? {}
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: [{ role: "user", content: userContent }],
        ...this.opts.jsonMode ?? true ? { response_format: { type: "json_object" } } : {},
        ...this.opts.extraBody ?? {}
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 12e4)
    });
    if (!res.ok) {
      throw new Error(`${this.opts.label} api ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const body = await res.json();
    const u = body.usage;
    if (u) {
      const usage = {};
      if (typeof u.prompt_tokens === "number") usage.promptTokens = u.prompt_tokens;
      if (typeof u.completion_tokens === "number") usage.outputTokens = u.completion_tokens;
      if (typeof u.total_tokens === "number") usage.totalTokens = u.total_tokens;
      if (Object.keys(usage).length) this.lastUsage = usage;
    }
    const text = body.choices?.[0]?.message?.content ?? "";
    return extractJson(text);
  }
};

// src/router/adapters/byok-gemini.ts
var ByokGeminiAdapter = class {
  constructor(opts) {
    this.opts = opts;
    this.name = `byok-gemini(${opts.model})`;
  }
  opts;
  name;
  rung = 2;
  lastUsage;
  async available() {
    return Boolean(this.opts.apiKey);
  }
  supports(_cap) {
    return true;
  }
  async generateJson(req) {
    if (!this.opts.apiKey) throw new Error("byok-gemini: no API key configured");
    this.lastUsage = void 0;
    const parts = [{ text: req.prompt }];
    if (req.imagePng) {
      parts.push({ inlineData: { mimeType: "image/png", data: req.imagePng.toString("base64") } });
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.opts.model}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.opts.apiKey
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: req.schema
          }
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 12e4)
      }
    );
    if (!res.ok) {
      throw new Error(`gemini api ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const body = await res.json();
    const um = body.usageMetadata;
    if (um) {
      const usage = {};
      if (typeof um.promptTokenCount === "number") usage.promptTokens = um.promptTokenCount;
      if (typeof um.candidatesTokenCount === "number") usage.outputTokens = um.candidatesTokenCount;
      if (typeof um.totalTokenCount === "number") usage.totalTokens = um.totalTokenCount;
      if (typeof um.cachedContentTokenCount === "number") usage.cachedTokens = um.cachedContentTokenCount;
      if (Object.keys(usage).length) this.lastUsage = usage;
    }
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return extractJson(text);
  }
};

// src/router/adapters/nano.ts
var NanoAdapter = class {
  constructor(nano) {
    this.nano = nano;
  }
  nano;
  name = "nano";
  rung = 0;
  async available() {
    try {
      return await this.nano.availability() === "available";
    } catch {
      return false;
    }
  }
  supports(cap) {
    return cap === "visual-verdict";
  }
  async generateJson(req) {
    if (!req.imagePng) throw new Error("nano adapter requires an image");
    const { verdict } = await this.nano.verdict(req.imagePng, req.prompt);
    return verdict;
  }
};

// src/capture/logpoints.ts
async function setLogpointByContent(client, spec) {
  const { result } = await client.Runtime.evaluate({
    expression: `fetch(${JSON.stringify(spec.url)}).then(r => r.text())`,
    awaitPromise: true,
    returnByValue: true
  });
  const source = result.value;
  if (typeof source !== "string") throw new Error(`could not fetch source of ${spec.url}`);
  const line = source.split("\n").findIndex((l) => l.includes(spec.lineContains));
  if (line < 0) throw new Error(`no line containing ${JSON.stringify(spec.lineContains)} in ${spec.url}`);
  const bp = await client.Debugger.setBreakpointByUrl({
    url: spec.url,
    lineNumber: line,
    condition: `console.log('[LOGPOINT]', ${spec.expression}), false`
  });
  if (bp.locations.length === 0) {
    throw new Error(`logpoint at ${spec.url}:${line + 1} resolved to 0 locations (script not loaded?)`);
  }
  return { breakpointId: bp.breakpointId, line };
}

// src/capture/axtree.ts
var MAX_CHARS = 6e3;
var INTERACTIVE = /* @__PURE__ */ new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "slider",
  "switch",
  "spinbutton"
]);
var STRUCTURAL = /* @__PURE__ */ new Set([
  "RootWebArea",
  "banner",
  "navigation",
  "main",
  "contentinfo",
  "complementary",
  "form",
  "region",
  "search",
  "heading",
  "table",
  "row",
  "cell",
  "columnheader",
  "rowheader",
  "list",
  "listitem",
  "image",
  "img",
  "alert",
  "alertdialog",
  "dialog",
  "status",
  "article",
  "figure"
]);
var STATE_PROPS = /* @__PURE__ */ new Set(["disabled", "focused", "required", "checked", "expanded", "invalid", "selected"]);
async function snapshotAxTree(client) {
  const { nodes } = await client.Accessibility.getFullAXTree({});
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId && !n.ignored) ?? nodes[0];
  if (!root) throw new Error("empty accessibility tree");
  const nodeMap = /* @__PURE__ */ new Map();
  let seq = 0;
  const keep = (role, name, parentName) => {
    if (INTERACTIVE.has(role) || STRUCTURAL.has(role)) return true;
    if (role === "StaticText") return name.length > 0 && name !== parentName;
    return name.length > 0 && name !== parentName;
  };
  const build = (raw, parentName) => {
    if (!raw || raw.ignored) {
      return (raw?.childIds ?? []).flatMap((cid) => build(byId.get(cid), parentName));
    }
    const role = raw.role?.value ?? "";
    if (role === "InlineTextBox" || role === "LineBreak") return [];
    const name = (raw.name?.value ?? "").trim();
    const children = (raw.childIds ?? []).flatMap((cid) => build(byId.get(cid), name || parentName));
    if (!keep(role, name, parentName)) return children;
    const states = (raw.properties ?? []).filter((p) => STATE_PROPS.has(p.name) && p.value?.value !== false && p.value?.value !== "false").map((p) => p.value?.value === true || p.value?.value === void 0 ? p.name : `${p.name}=${p.value.value}`);
    const id = `n${seq++}`;
    if (raw.backendDOMNodeId !== void 0) nodeMap.set(id, raw.backendDOMNodeId);
    const node = { id, role, ...name && { name }, ...raw.value?.value && { value: raw.value.value }, ...states.length && { states }, ...children.length && { children } };
    return [node];
  };
  const roots = build(root, "");
  const rootNode = roots.length === 1 ? roots[0] : { id: `n${seq++}`, role: "RootWebArea", children: roots };
  let { text, truncated } = serialize(rootNode);
  return { snapshot: { root: rootNode, text, truncated }, nodeMap };
}
function serialize(root) {
  const lines = [];
  const walk = (n, depth) => {
    const parts = [n.id, n.role];
    if (n.name) parts.push(JSON.stringify(n.name));
    if (n.value) parts.push(`value=${JSON.stringify(n.value)}`);
    if (n.states?.length) parts.push(`(${n.states.join(", ")})`);
    lines.push("  ".repeat(depth) + parts.join(" "));
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  let text = lines.join("\n");
  let truncated = false;
  if (text.length > MAX_CHARS) {
    const head = lines.slice(0, Math.floor(lines.length * 0.4));
    const keepChars = MAX_CHARS - head.join("\n").length - 64;
    const tail = [];
    let used = 0;
    for (let i = lines.length - 1; i >= head.length && used < keepChars; i--) {
      used += lines[i].length + 1;
      tail.unshift(lines[i]);
    }
    text = [...head, `  \u2026 (${lines.length - head.length - tail.length} nodes truncated) \u2026`, ...tail].join("\n");
    truncated = true;
  }
  return { text, truncated };
}

// src/bridge/cdp-shim.ts
function buildCdpClient(transport) {
  const eventHandlers = /* @__PURE__ */ new Map();
  const unsubscribe = transport.subscribe((method, params) => {
    const handlers = eventHandlers.get(method);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(params ?? {});
      } catch {
      }
    }
  });
  const makeMember = (domain, name) => {
    const fullName = `${domain}.${name}`;
    const member = ((arg) => {
      if (typeof arg === "function") {
        let set = eventHandlers.get(fullName);
        if (!set) {
          set = /* @__PURE__ */ new Set();
          eventHandlers.set(fullName, set);
        }
        set.add(arg);
        return () => set.delete(arg);
      }
      return transport.send(fullName, arg ?? {});
    });
    return member;
  };
  const domainProxies = /* @__PURE__ */ new Map();
  const domainProxy = (domain) => {
    let proxy = domainProxies.get(domain);
    if (proxy) return proxy;
    const members = /* @__PURE__ */ new Map();
    proxy = new Proxy({}, {
      get(_t, name) {
        if (typeof name !== "string") return void 0;
        let m = members.get(name);
        if (!m) {
          m = makeMember(domain, name);
          members.set(name, m);
        }
        return m;
      }
    });
    domainProxies.set(domain, proxy);
    return proxy;
  };
  const client = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== "string") return void 0;
      if (prop === "close") return async () => {
      };
      if (prop === "then") return void 0;
      return domainProxy(prop);
    }
  });
  return {
    client,
    dispose() {
      unsubscribe();
      eventHandlers.clear();
    }
  };
}

// src/extension/lite-extension-browser.ts
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
var LiteExtensionBrowser = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  shim = null;
  capture = null;
  /** planner nodeId ("n7") → backendDOMNodeId; refreshed by every axTree(). */
  nodeMap = /* @__PURE__ */ new Map();
  lastSnapshot = null;
  get c() {
    if (!this.shim) throw new Error("LiteExtensionBrowser: launch() first");
    return this.shim.client;
  }
  /** Raw CDP-shaped client for extras outside the BrowserPort contract. */
  cdpClient() {
    return this.c;
  }
  async launch() {
    if (this.shim) return;
    this.shim = buildCdpClient(this.deps.transport);
    await Promise.all([
      this.c.Page.enable(),
      this.c.Runtime.enable(),
      this.c.Debugger.enable(),
      this.c.DOM.enable(),
      this.c.Accessibility.enable()
    ]);
    this.capture = await attachCapture(this.c);
  }
  async navigate(url) {
    this.emitCursor({ kind: "caption", caption: "Opening " + url });
    await this.deps.navigate(url);
    await sleep2(300);
  }
  async url() {
    return this.deps.getUrl();
  }
  async axTree() {
    const { snapshot, nodeMap } = await snapshotAxTree(this.c);
    this.nodeMap = nodeMap;
    this.lastSnapshot = snapshot;
    return snapshot;
  }
  /** Human-readable label for a nodeId, e.g. `the "Sign in" button`. */
  nodeLabel(nodeId) {
    const find = (node2) => {
      if (!node2) return void 0;
      if (node2.id === nodeId) return node2;
      for (const child of node2.children ?? []) {
        const hit = find(child);
        if (hit) return hit;
      }
      return void 0;
    };
    const node = find(this.lastSnapshot?.root);
    if (!node) return "an element";
    const role = node.role || "element";
    if (node.name) return `the ${JSON.stringify(node.name)} ${role}`;
    return `a ${role}`;
  }
  /** Fire a cursor overlay event; never let UI fan-out fail the action. */
  emitCursor(params) {
    try {
      this.deps.onCursor(params);
    } catch {
    }
  }
  backendNodeId(nodeId) {
    const backendId = this.nodeMap.get(nodeId);
    if (backendId === void 0) {
      throw new Error(`unknown nodeId ${nodeId} \u2014 stale snapshot? (re-run axTree)`);
    }
    return backendId;
  }
  async click(nodeId) {
    const backendNodeId = this.backendNodeId(nodeId);
    await this.c.Page.bringToFront().catch(() => {
    });
    await this.c.DOM.scrollIntoViewIfNeeded({ backendNodeId }).catch(() => {
    });
    const { model } = await this.c.DOM.getBoxModel({ backendNodeId });
    const quad = model.content;
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    this.emitCursor({ kind: "move", x, y, caption: "Clicking " + this.nodeLabel(nodeId) });
    await sleep2(350);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.c.Input.dispatchMouseEvent({ type, x, y, button: "left", clickCount: 1 });
    }
    this.emitCursor({ kind: "click", x, y });
    await sleep2(400);
  }
  async type(nodeId, text) {
    const backendNodeId = this.backendNodeId(nodeId);
    await this.c.Page.bringToFront().catch(() => {
    });
    await this.c.DOM.scrollIntoViewIfNeeded({ backendNodeId }).catch(() => {
    });
    try {
      const { model } = await this.c.DOM.getBoxModel({ backendNodeId });
      const quad = model.content;
      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      this.emitCursor({ kind: "type", x, y, caption: "Typing into " + this.nodeLabel(nodeId) });
      await sleep2(350);
    } catch {
      this.emitCursor({ kind: "caption", caption: "Typing into " + this.nodeLabel(nodeId) });
    }
    await this.c.DOM.focus({ backendNodeId });
    await this.c.Input.dispatchKeyEvent({
      type: "rawKeyDown",
      modifiers: 2,
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65
    });
    await this.c.Input.dispatchKeyEvent({
      type: "keyUp",
      modifiers: 2,
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65
    });
    await this.c.Input.insertText({ text });
    await sleep2(150);
    await this.verifyTyped(backendNodeId, text);
  }
  /** Read the field's live `.value` via DOM.resolveNode → Runtime.callFunctionOn. */
  async liveValue(backendNodeId) {
    const { object } = await this.c.DOM.resolveNode({ backendNodeId });
    if (!object.objectId) return void 0;
    try {
      const { result } = await this.c.Runtime.callFunctionOn({
        objectId: object.objectId,
        functionDeclaration: "function () { return this.value; }",
        returnByValue: true
      });
      return result.value;
    } finally {
      await this.c.Runtime.releaseObject({ objectId: object.objectId }).catch(() => {
      });
    }
  }
  /** Confirm insertText took; else fall back to per-character key events. */
  async verifyTyped(backendNodeId, expected) {
    if (await this.liveValue(backendNodeId) === expected) return;
    await this.typeByKeyEvents(backendNodeId, expected);
    const after = await this.liveValue(backendNodeId);
    if (after !== expected) {
      throw new Error(
        `type() failed: field value is ${JSON.stringify(after)} after both insertText and per-character key events (expected ${JSON.stringify(expected)})`
      );
    }
  }
  /** Per-character fallback: Ctrl+A clear then keyDown/char/keyUp per char. */
  async typeByKeyEvents(backendNodeId, text) {
    await this.c.DOM.focus({ backendNodeId });
    await this.c.Input.dispatchKeyEvent({
      type: "rawKeyDown",
      modifiers: 2,
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65
    });
    await this.c.Input.dispatchKeyEvent({
      type: "keyUp",
      modifiers: 2,
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65
    });
    for (const ch of text) {
      await this.c.Input.dispatchKeyEvent({ type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
      await this.c.Input.dispatchKeyEvent({ type: "char", text: ch, unmodifiedText: ch, key: ch });
      await this.c.Input.dispatchKeyEvent({ type: "keyUp", key: ch });
    }
    await sleep2(100);
  }
  async screenshot() {
    const { data } = await this.c.Page.captureScreenshot({ format: "png" });
    return Buffer.from(data, "base64");
  }
  async setLogpoint(spec) {
    await setLogpointByContent(this.c, spec);
  }
  drainConsole() {
    return this.capture?.drainConsole() ?? [];
  }
  drainNetwork() {
    return this.capture?.drainNetwork() ?? [];
  }
  /** Stamp a stable data-qa-id on a (typically name-less) node — recorder fallback. */
  async stampQaId(nodeId) {
    const backendNodeId = this.backendNodeId(nodeId);
    let objectId;
    try {
      const { object } = await this.c.DOM.resolveNode({ backendNodeId });
      objectId = object.objectId;
      if (!objectId) return null;
      const id = `qa-${crypto.randomUUID().slice(0, 8)}`;
      await this.c.Runtime.callFunctionOn({
        objectId,
        functionDeclaration: 'function (id) { this.setAttribute("data-qa-id", id); return id; }',
        arguments: [{ value: id }],
        returnByValue: true
      });
      return id;
    } catch {
      return null;
    } finally {
      if (objectId) await this.c.Runtime.releaseObject({ objectId }).catch(() => {
      });
    }
  }
  /** Resolve a previously stamped data-qa-id to a clickable nodeId. */
  async findByQaId(qaId) {
    try {
      const { root } = await this.c.DOM.getDocument({ depth: 0 });
      const sel = `[data-qa-id="${qaId.replace(/"/g, '\\"')}"]`;
      const { nodeId: domNodeId } = await this.c.DOM.querySelector({ nodeId: root.nodeId, selector: sel });
      if (!domNodeId) return null;
      const { node } = await this.c.DOM.describeNode({ nodeId: domNodeId });
      const backendNodeId = node.backendNodeId;
      if (backendNodeId === void 0) return null;
      const synthetic = `qa:${qaId}`;
      this.nodeMap.set(synthetic, backendNodeId);
      return synthetic;
    } catch {
      return null;
    }
  }
  async close() {
    try {
      await this.deps.detach();
    } catch {
    }
    this.shim?.dispose();
    this.shim = null;
    this.capture = null;
    this.nodeMap.clear();
    this.lastSnapshot = null;
  }
};

// src/extension/lite-nano.ts
var LiteNano = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  async start() {
  }
  async availability() {
    return this.deps.avail();
  }
  async ensureModel() {
    const a = await this.availability();
    if (a === "available") return a;
    throw new Error(`Gemini Nano not available (availability: ${a})`);
  }
  async warmup() {
    await this.deps.warmup();
  }
  async verdict(png, task) {
    const dataUrl = "data:image/png;base64," + png.toString("base64");
    return this.deps.verdict(dataUrl, task);
  }
  async close() {
  }
};

// src/extension/browser-artifacts.ts
var BrowserArtifactStore = class {
  runId;
  dir;
  /** synthetic path → base64 PNG (download-only, in memory for this session). */
  screenshots = /* @__PURE__ */ new Map();
  report = null;
  audit = [];
  constructor() {
    this.runId = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19) + "-" + Math.random().toString(36).slice(2, 6);
    this.dir = `artifacts/${this.runId}`;
  }
  /** The returned path string only flows into report.evidence_paths/screenshot
   * fields — it is never opened by the engine, so a synthetic path is fine. */
  saveScreenshot(stepIndex, png) {
    const name = `screenshots/step-${String(stepIndex).padStart(2, "0")}.png`;
    this.screenshots.set(name, png.toString("base64"));
    return `${this.dir}/${name}`;
  }
  saveReport(report) {
    this.report = report;
    return `${this.dir}/report.json`;
  }
  /** Append one entry per executed action (already redacted by the caller). */
  appendAudit(entry) {
    this.audit.push(entry);
  }
  /** Everything the panel needs to offer downloads (report.json + screenshots). */
  exportBundle() {
    return {
      runId: this.runId,
      reportJson: this.report ? JSON.stringify(this.report, null, 2) : "{}",
      screenshots: [...this.screenshots].map(([name, base64]) => ({ name, base64 })),
      audit: this.audit
    };
  }
};

// src/vibe/settings-data.ts
var DEFAULT_SETTINGS = {
  // Default planner: claude CLI. The old default (gemini:cli, free Gemini quota)
  // died on 2026-06-18 (IneligibleTierError), so it's a broken out-of-box choice.
  // claude CLI needs no API key and is near-ubiquitous in this tool's audience;
  // if it's absent the router falls through the ladder to codex/BYOK/Ollama.
  // (Lite mode overrides this to a BYOK provider — it has no CLI rungs.)
  planner: { provider: "claude", mode: "cli" },
  debugMode: "prompt",
  debugAgent: "auto"
};
var DEFAULT_MODELS = {
  "gemini:api": "gemini-3-flash-preview",
  "gemini:cli": "gemini-3-flash-preview",
  "claude:api": "claude-haiku-4-5",
  "claude:cli": "claude-haiku-4-5",
  "gpt:api": "gpt-4o-mini",
  "gpt:cli": "",
  // codex uses its own configured model
  "ollama:api": "llama3.2-vision",
  "openrouter:api": "anthropic/claude-3.5-haiku",
  "glm:api": "glm-5.2"
  // z.ai GLM-5.2 (text-only reasoning model; planner-only)
};
function defaultModelFor(provider, mode) {
  return DEFAULT_MODELS[`${provider}:${mode}`] ?? "";
}
function isSafeModelId(model) {
  return /^[A-Za-z0-9._:/+-]+$/.test(model);
}
var VAULT_KEY_FOR = {
  gemini: "gemini",
  claude: "anthropic",
  gpt: "openai",
  openrouter: "openrouter",
  glm: "glm"
};
var PROVIDER_MODES = {
  nano: ["ondevice"],
  gemini: ["api", "cli"],
  claude: ["api", "cli"],
  gpt: ["api", "cli"],
  ollama: ["api"],
  openrouter: ["api"],
  glm: ["api"]
};
var PROVIDER_ORDER = ["nano", "gemini", "claude", "gpt", "ollama", "openrouter", "glm"];

// src/vibe/fix-prompt.ts
function humanizeStep(step) {
  const a = step.action;
  const t = step.target;
  const targetPhrase = t ? t.name ? `the "${t.name}" ${t.role}` : `the ${t.role}` : void 0;
  switch (a.type) {
    case "navigate":
      return `opened ${a.url}`;
    case "click":
      return `clicked ${targetPhrase ?? "an element"}`;
    case "type":
      return `typed ${JSON.stringify(a.text)} into ${targetPhrase ?? "a field"}`;
    case "assert_visual":
      return `checked the page looked right: ${a.expectation}`;
    case "assert_dom":
      return `checked ${targetPhrase ?? "the page"} contained ${JSON.stringify(a.contains)}`;
    case "wait":
      return `waited ${Math.round(a.ms / 100) / 10}s for the page to settle`;
    case "finish":
      return a.verdict === "pass" ? "confirmed the task was done" : `decided the task failed: ${a.reason}`;
  }
}
function actionSteps(report) {
  return report.steps.filter((s) => s.action.type !== "finish");
}
function failedCalls(step) {
  if (!step) return [];
  return step.network.filter((n) => n.failed || typeof n.status === "number" && n.status >= 400);
}
function failingRecord(report) {
  if (!report.failing_step) return void 0;
  return report.steps.find((s) => s.index === report.failing_step.index);
}
function describeCall(n) {
  const where = `${n.method} ${n.url}`;
  if (typeof n.status === "number") return `${where} returned ${n.status}`;
  if (n.failed) return `${where} failed${n.errorText ? ` (${n.errorText})` : ""}`;
  return where;
}
function renderPlainReport(report) {
  const lines = [];
  const headline = report.verdict === "pass" ? "\u2705 Everything worked" : report.verdict === "fail" ? "\u274C Found the problem" : "\u{1F914} Couldn\u2019t finish";
  lines.push(`## ${headline}`);
  lines.push("");
  lines.push(`I tested: ${report.task}`);
  lines.push("");
  const did = actionSteps(report);
  lines.push("**What I did:**");
  if (did.length === 0) {
    lines.push("1. (no steps were taken)");
  } else {
    did.forEach((s, i) => {
      const mark = s.ok ? "" : " \u2014 this is where it broke";
      lines.push(`${i + 1}. ${humanizeStep(s)}${mark}`);
    });
  }
  if (report.verdict !== "pass") {
    lines.push("");
    lines.push("**What went wrong:**");
    lines.push(report.reason);
    if (report.console_error) {
      lines.push("");
      lines.push(`The page reported this error: ${report.console_error}`);
    }
    const calls = failedCalls(failingRecord(report));
    if (calls.length) {
      lines.push("");
      lines.push("These requests failed:");
      for (const c of calls) lines.push(`- ${describeCall(c)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
function expectedFromTask(task) {
  const t = task.trim();
  const lower = t.toLowerCase();
  if (/^(test|verify|check|make sure|ensure|confirm)\b/.test(lower)) {
    const stripped = t.replace(/^(test|verify|check|make sure that|make sure|ensure that|ensure|confirm that|confirm)\s+/i, "");
    return `${stripped} should work without errors.`;
  }
  return `${t} \u2014 this should complete without errors.`;
}
function rootCauseLines(consoleError, calls) {
  const out = [];
  if (consoleError) {
    const m = /TypeError:.*?(?:reading|of)\s+'([^']+)'/i.exec(consoleError) ?? /Cannot read propert(?:y|ies) (?:of|')([^'\s]+)/i.exec(consoleError);
    if (/TypeError/i.test(consoleError)) {
      const prop = m?.[1];
      out.push(
        prop ? `The code accesses \`${prop}\` on a value that is undefined/null \u2014 check where that object is built before this point.` : "The code accesses a property of an undefined value \u2014 check where that object is built before this point."
      );
    }
  }
  for (const c of calls) {
    if (typeof c.status === "number" && c.status >= 500) {
      const route = safeRoute(c.url);
      out.push(`The ${c.method} ${route} endpoint is failing server-side (HTTP ${c.status}) \u2014 check that handler and its dependencies.`);
    } else if (typeof c.status === "number" && c.status >= 400) {
      const route = safeRoute(c.url);
      out.push(`The ${c.method} ${route} request was rejected (HTTP ${c.status}) \u2014 check the request payload/auth.`);
    } else if (c.failed) {
      out.push(`The ${c.method} ${safeRoute(c.url)} request never completed (${c.errorText ?? "network failure"}).`);
    }
  }
  if (out.length === 0) {
    out.push("Reproduce the steps above and inspect the console/network panels at the failing step.");
  }
  return out;
}
function safeRoute(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
function buildFixPrompt(report) {
  if (report.verdict === "pass") return "";
  const lines = [];
  lines.push("Fix this bug found by automated browser testing:");
  lines.push("");
  lines.push("**Steps to reproduce**");
  lines.push(`1. Start at ${report.url}`);
  const did = actionSteps(report);
  did.forEach((s, i) => lines.push(`${i + 2}. ${humanizeStep(s)}`));
  lines.push("");
  const failRec = failingRecord(report);
  const calls = failedCalls(failRec);
  lines.push("**What happens**");
  lines.push(report.reason);
  if (report.console_error) {
    lines.push("");
    lines.push("Console error:");
    lines.push("```");
    lines.push(report.console_error);
    lines.push("```");
  }
  if (calls.length) {
    lines.push("");
    lines.push("Failed network requests:");
    for (const c of calls) lines.push(`- ${describeCall(c)}`);
  }
  lines.push("");
  lines.push("**Expected**");
  lines.push(expectedFromTask(report.task));
  lines.push("");
  lines.push("**Evidence**");
  if (failRec) {
    lines.push(`- Failed at step ${did.findIndex((s) => s.index === failRec.index) + 1 || failRec.index + 1} (${new Date(failRec.ts).toISOString()})`);
  }
  const shots = report.evidence_paths.filter((p) => p.endsWith(".png"));
  for (const p of shots) lines.push(`- Screenshot: ${baseName(p)}`);
  lines.push("");
  lines.push("**Likely root cause**");
  for (const rc of rootCauseLines(report.console_error, calls)) lines.push(`- ${rc}`);
  lines.push("");
  lines.push("Fix the root cause; do not change unrelated files.");
  return lines.join("\n");
}
function baseName(p) {
  const m = /[^\\/]+$/.exec(p);
  return m ? m[0] : p;
}

// src/extension/lite-engine.ts
function buildLiteLadder(keys, planner) {
  const modelFor = (provider, fallback) => planner.provider === provider && planner.mode === "api" && planner.model ? planner.model : fallback;
  const byKey = /* @__PURE__ */ new Map();
  byKey.set("gemini", new ByokGeminiAdapter({ apiKey: keys.gemini, model: modelFor("gemini", defaultModelFor("gemini", "api")) }));
  byKey.set("claude", new AnthropicAdapter({ apiKey: keys.anthropic, model: modelFor("claude", defaultModelFor("claude", "api")), browserDirect: true }));
  byKey.set("gpt", new OpenAiCompatibleAdapter({ apiKey: keys.openai, baseUrl: "https://api.openai.com/v1", label: "gpt", model: modelFor("gpt", defaultModelFor("gpt", "api")) }));
  byKey.set("openrouter", new OpenAiCompatibleAdapter({ apiKey: keys.openrouter, baseUrl: "https://openrouter.ai/api/v1", label: "openrouter", model: modelFor("openrouter", defaultModelFor("openrouter", "api")) }));
  byKey.set("glm", new OpenAiCompatibleAdapter({ apiKey: keys.glm, baseUrl: "https://api.z.ai/api/paas/v4", label: "glm", model: modelFor("glm", defaultModelFor("glm", "api")), supportsVision: false, extraBody: { thinking: { type: "disabled" } } }));
  const pinnedName = byKey.get(planner.provider)?.name;
  return { adapters: [...byKey.values()], pinnedName };
}
function buildLiteConfig(keys, settings) {
  const k = keys;
  const providers = PROVIDER_ORDER.map((id) => {
    const vaultName = VAULT_KEY_FOR[id];
    const needsKey = Boolean(vaultName);
    return {
      id,
      modes: PROVIDER_MODES[id],
      apiModelDefault: defaultModelFor(id, "api"),
      cliModelDefault: defaultModelFor(id, "cli"),
      needsKey,
      hasKey: needsKey ? Boolean(k[vaultName]) : false,
      // lite mode can't drive CLI/Ollama rungs — flag unsupported providers so the
      // panel can hint (nano plans nothing; ollama needs a local server).
      liteUsable: id !== "nano" && id !== "ollama"
    };
  });
  return {
    planner: settings.planner,
    debugMode: settings.debugMode,
    debugAgent: settings.debugAgent,
    providers,
    mode: "lite"
  };
}
async function runLite(opts) {
  const progress = opts.onProgress ?? (() => {
  });
  const browser = new LiteExtensionBrowser(opts.browserDeps);
  await browser.launch();
  try {
    const adapters = [];
    if (opts.nanoDeps) {
      const nano = new LiteNano(opts.nanoDeps);
      const a = await nano.availability().catch(() => "unavailable");
      if (a === "available") {
        progress("rung 0: Gemini Nano available \u2014 warming up");
        await nano.warmup().catch(() => {
        });
        adapters.push(new NanoAdapter(nano));
      } else {
        progress(`rung 0: Gemini Nano ${a} \u2014 visual checks fall to the cloud model`);
      }
    }
    const { adapters: ladder, pinnedName } = buildLiteLadder(opts.keys, opts.planner);
    adapters.push(...ladder);
    progress(`planner: ${pinnedName ?? opts.planner.provider} (BYOK; lite mode \u2014 no daemon)`);
    const router = new ModelRouter(adapters, { pinnedAdapter: pinnedName });
    const artifacts = new BrowserArtifactStore();
    progress(`run ${artifacts.runId}: "${opts.task}" on ${opts.url}`);
    const report = await runDriverLoop(browser, router, artifacts, opts.task, opts.url, {
      maxSteps: opts.maxSteps ?? 12,
      onStep: opts.onStep,
      allowedHosts: opts.allowedHosts,
      signal: opts.signal
      // no vault in lite mode — a {{secret:NAME}} placeholder fails its step.
    });
    progress(`verdict: ${report.verdict} (${report.steps.length} steps, ${Math.round(report.durationMs / 1e3)}s)`);
    const done = {
      ...slimReport(report),
      plainReport: renderPlainReport(report),
      fixPrompt: buildFixPrompt(report),
      durationMs: report.durationMs
    };
    return { report, bundle: artifacts.exportBundle(), done };
  } finally {
    await browser.close();
  }
}
export {
  DEFAULT_SETTINGS,
  buildLiteConfig,
  defaultModelFor,
  isSafeModelId,
  runLite
};
