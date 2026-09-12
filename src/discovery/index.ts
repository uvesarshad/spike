/* Discovery & coverage layer — A23 (P0) + A25 (P1).
 *
 * See docs/plan/26-08-08-audit-deterministic-speed.md (A23, A25) and
 * docs/plan/26-08-08-options-autonomy-layer.md (same finding IDs) for the
 * design this module implements. Public API a CLI/daemon caller drives:
 *
 *   - `discoverApp(opts)`      — run the discovery ladder, return a fresh AppModel
 *   - `loadAppModel(root)`     — read `.spike/app-model.json`
 *   - `saveAppModel(model, root)` — persist it
 *   - `coverageReport(model)` — route + interactive-element coverage
 *   - `diffAppModel(prev, curr)` — A25's new/changed/removed classification
 *
 * Nothing here imports engine.ts, driver/loop.ts, or any BrowserPort — the
 * crawl takes an injected fetch-or-navigate function (`Fetcher`) so this
 * whole layer stays testable without a browser and reusable from a future
 * live-loop integration alike. */

export { discoverApp, type DiscoverAppOptions, type InteractionGatedCandidate } from './discover.js';

export {
  makeInteractionExplorer,
  explorationOptions,
  offerableControls,
  buildExplorePrompt,
  parseExploreDecision,
  EXPLORE_JSON_SCHEMA,
  DEFAULT_MAX_ACTIONS_PER_PAGE,
  DEFAULT_MAX_ACTIONS_PER_RUN,
  DEFAULT_MAX_PAGES,
  type ExplorationResult,
  type ExplorationWiring,
  type InteractionExplorerOptions,
  type ExploreBrowser,
  type ExplorePlanner,
  type ExploreAxNode,
} from './explore.js';

export {
  APP_MODEL_VERSION,
  emptyAppModel,
  appModelPath,
  loadAppModel,
  saveAppModel,
  upsertCrawledPage,
  upsertExploredState,
  upsertRunRoute,
  upsertStaticRoute,
  markRouteExercised,
  markElementTouched,
  findingsForPage,
  hasBlockingFindings,
  type AppModelFinding,
  type FindingKind,
  type FindingSeverity,
  type AppModel,
  type AppModelRoute,
  type AppModelState,
  type AppModelElement,
  type ExploredState,
} from './app-model.js';

export { coverageReport, type CoverageReport, type RouteCoverage, type ElementCoverage, type RouteCoverageDetail } from './coverage.js';

export { diffAppModel, type AppModelDiff, type AppModelDiffEntry, type DiffKind } from './diff.js';

export {
  crawlSite,
  collapseParameterizedPath,
  type CrawlOptions,
  type CrawlResult,
  type CrawledPage,
  type Fetcher,
  type Fetched,
  type FailedRequest,
} from './crawler.js';

export { browserFetcher, interactiveElementsFromAx, type CrawlBrowser, type BrowserCrawlOptions, type AxNodeLike } from './browser-crawl.js';

export {
  checkTargets,
  checkInstruction,
  renderCheckSummary,
  DEFAULT_CHECK_PAGES,
  LITE_CHECK_PAGES,
  LITE_CAP_NOTE,
  type CheckTarget,
  type CheckSummaryInput,
} from './site-check.js';

export { parseSitemapXml, parseRobotsTxt, routesFromFileList, routesFromBundle, type RouterKind } from './static-routes.js';

export {
  structuralSignatureFromAx,
  collectDepthRolePairs,
  signatureFromPairs,
  structuralMaterialFromPairs,
  type StructuralNode,
  type StructuralSnapshot,
} from './signature.js';

export {
  extractLinks,
  extractInteractiveElements,
  structuralSignatureFromHtml,
  extractScriptUrls,
  findDeadLinks,
  collectHtmlDepthRolePairs,
  htmlToStructuralNode,
  type InteractiveElement,
} from './html.js';

export { applyRunToModel, recordRunCoverage, type CoverageWriteResult } from './record-coverage.js';
