/* V65 — market-readiness "Surface map/coverage in the side panel" enhancement.
 *
 * VibeService.start() (src/vibe/service.ts) now registers two read-only bridge
 * methods for the panel's "Site map" card:
 *
 *   vibe.map.get      {host?} → {present:false} | {present:true, baseUrl?,
 *                                routeCount, stateCount, lastMappedAt}
 *   vibe.coverage.get {host?} → {present:false} | {present:true, routes,
 *                                interactiveElements, perRoute}
 *
 * Both read `.spike/app-model.json` (from `spike map`) via
 * src/discovery/app-model.ts's `loadAppModel` and, for coverage, hand it
 * straight to src/discovery/coverage.ts's `coverageReport` — no hand-rolled
 * JSON parsing or coverage math lives in service.ts. Both are scoped to the
 * caller's `host`: when a host is given and the model was mapped for a
 * DIFFERENT host, the handler reports {present:false} rather than surfacing
 * data for the wrong site.
 *
 * NO real BridgeServer/socket here (that belongs in the browser bucket, see
 * v7/v9) — the same in-memory FakeBridge shape as v57.vibe-detach-abort.ts,
 * extended to actually capture onRequest handlers (v57's FakeBridge no-ops
 * onRequest since it only needed onEvent). This isolates exactly the two new
 * handlers' logic — host-scoping + delegation to the discovery module — from
 * the transport plumbing already covered elsewhere.
 *
 * File I/O: each scenario writes a real `.spike/app-model.json` to a scratch
 * temp directory and chdir()s the test process into it, because the handlers
 * call `loadAppModel(process.cwd())` exactly as the CLI's `spike map`/`spike
 * coverage` commands do (see src/cli.ts) — no root-override seam was added to
 * the bridge protocol for this pass. The original cwd is restored in a
 * `finally` so a later suite in the same run (if ever co-located) is
 * unaffected. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VibeService } from '../src/vibe/service.js';
import type { BridgeServer } from '../src/bridge/bridge-server.js';
import { emptyAppModel, saveAppModel, coverageReport, type AppModel } from '../src/discovery/index.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

type Handler = (params: unknown, ctx: { clientId: number }) => Promise<unknown>;

/** Minimal stand-in for BridgeServer's public surface, extended from v57's to
 * actually capture onRequest handlers (v57 only needed onEvent). */
class FakeBridge {
  private requestHandlers = new Map<string, Handler>();
  onRequest(method: string, handler: Handler): void {
    this.requestHandlers.set(method, handler);
  }
  onEvent(): void {
    /* the map/coverage handlers under test don't touch events */
  }
  offEvent(): void {}
  sendEvent(): void {}
  isAuthenticated(): boolean {
    return true;
  }
  call(): Promise<unknown> {
    return Promise.resolve({ ok: true });
  }

  /** Invoke a registered request handler exactly as BridgeServer would for a
   * real `{id, method, params}` frame from the panel. Throws if unregistered. */
  async request(method: string, params: unknown = {}): Promise<unknown> {
    const h = this.requestHandlers.get(method);
    if (!h) throw new Error(`no handler registered for ${method}`);
    return h(params, { clientId: 1 });
  }
}

function makeService(): { service: VibeService; bridge: FakeBridge } {
  const bridge = new FakeBridge();
  const service = new VibeService(bridge as unknown as BridgeServer);
  service.start();
  return { service, bridge };
}

/** Runs `fn` with process.cwd() pointed at a fresh scratch directory
 * (optionally pre-seeded with an AppModel at `.spike/app-model.json`),
 * restoring the original cwd afterward even if `fn` throws. */
async function withScratchCwd(model: AppModel | null, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v64-'));
  const originalCwd = process.cwd();
  try {
    if (model) saveAppModel(model, dir);
    process.chdir(dir);
    await fn(dir);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeMappedModel(): AppModel {
  const model = emptyAppModel('https://example.com');
  model.routes.push({
    route: 'https://example.com/',
    source: 'crawl',
    discoveredAt: model.generatedAt,
    exercised: true,
    lastExercisedAt: model.generatedAt,
    coveredByScripts: ['home.json'],
    states: [
      {
        structuralSignature: 'sig-a',
        firstSeenAt: model.generatedAt,
        lastSeenAt: model.generatedAt,
        elements: [
          { role: 'link', name: 'Products', discoveredAt: model.generatedAt, touchedAt: model.generatedAt, coveredByScripts: ['home.json'] },
          { role: 'button', name: 'Sign in', discoveredAt: model.generatedAt, coveredByScripts: [] },
        ],
      },
    ],
  });
  model.routes.push({
    route: 'https://example.com/checkout',
    source: 'crawl',
    discoveredAt: model.generatedAt,
    exercised: false,
    coveredByScripts: [],
    states: [
      {
        structuralSignature: 'sig-b',
        firstSeenAt: model.generatedAt,
        lastSeenAt: model.generatedAt,
        elements: [],
      },
    ],
  });
  return model;
}

async function noModelReportsAbsent(): Promise<void> {
  await withScratchCwd(null, async () => {
    const { bridge } = makeService();
    const mapResult = (await bridge.request('vibe.map.get', { host: 'example.com' })) as { present: boolean };
    const covResult = (await bridge.request('vibe.coverage.get', { host: 'example.com' })) as { present: boolean };
    check('vibe.map.get reports absent with no .spike/app-model.json', mapResult.present === false);
    check('vibe.coverage.get reports absent with no .spike/app-model.json', covResult.present === false);
  });
}

async function matchingHostReturnsSummary(): Promise<void> {
  const model = makeMappedModel();
  await withScratchCwd(model, async () => {
    const { bridge } = makeService();
    const result = (await bridge.request('vibe.map.get', { host: 'example.com' })) as {
      present: boolean;
      baseUrl?: string;
      routeCount: number;
      stateCount: number;
      lastMappedAt: string;
    };
    check('vibe.map.get present:true for the mapped host', result.present === true);
    check('routeCount matches the model (2 routes)', result.routeCount === 2);
    check('stateCount matches the model (1 state per route = 2)', result.stateCount === 2);
    check('baseUrl passes through', result.baseUrl === 'https://example.com');
    check('lastMappedAt is the model.generatedAt timestamp', result.lastMappedAt === model.generatedAt);
  });
}

async function noHostParamReturnsSummaryAnyway(): Promise<void> {
  const model = makeMappedModel();
  await withScratchCwd(model, async () => {
    const { bridge } = makeService();
    const result = (await bridge.request('vibe.map.get', {})) as { present: boolean; routeCount: number };
    check('omitted host still returns the summary (unscoped request)', result.present === true && result.routeCount === 2);
  });
}

async function mismatchedHostReportsAbsent(): Promise<void> {
  const model = makeMappedModel();
  await withScratchCwd(model, async () => {
    const { bridge } = makeService();
    const mapResult = (await bridge.request('vibe.map.get', { host: 'other-site.com' })) as { present: boolean };
    const covResult = (await bridge.request('vibe.coverage.get', { host: 'other-site.com' })) as { present: boolean };
    check('vibe.map.get present:false for a non-matching host (no stale cross-site data)', mapResult.present === false);
    check('vibe.coverage.get present:false for a non-matching host', covResult.present === false);
  });
}

async function coverageDelegatesToCoverageReport(): Promise<void> {
  const model = makeMappedModel();
  await withScratchCwd(model, async () => {
    const { bridge } = makeService();
    const result = (await bridge.request('vibe.coverage.get', { host: 'example.com' })) as {
      present: boolean;
      routes: unknown;
      interactiveElements: unknown;
      perRoute: unknown;
    };
    const expected = coverageReport(model);
    check('vibe.coverage.get present:true for the mapped host', result.present === true);
    check('routes summary matches discovery/coverage.ts coverageReport()', JSON.stringify(result.routes) === JSON.stringify(expected.routes));
    check(
      'interactiveElements summary matches coverageReport()',
      JSON.stringify(result.interactiveElements) === JSON.stringify(expected.interactiveElements),
    );
    check('perRoute breakdown matches coverageReport() (not hand-rolled)', JSON.stringify(result.perRoute) === JSON.stringify(expected.perRoute));
  });
}

async function main(): Promise<void> {
  await noModelReportsAbsent();
  await matchingHostReturnsSummary();
  await noHostParamReturnsSummaryAnyway();
  await mismatchedHostReportsAbsent();
  await coverageDelegatesToCoverageReport();

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} v65 checks passed`);
  process.exit(failed.length ? 1 : 0);
}

void main();
