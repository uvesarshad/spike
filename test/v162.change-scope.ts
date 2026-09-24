/* v162 — E7: git diff → affected routes; `spike ci --changed-since`. Git is stubbed. */
import { anyRouteMatches, changedFiles, ChangeScopeError, routeMatches, scopeFromFiles, type GitRunner } from '../src/change-scope/change-scope.js';
import { runCi } from '../src/ci/ci.js';

let bad = 0;
const check = (label: string, ok: boolean) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); };

const s1 = scopeFromFiles(['app/products/[id]/page.tsx', 'src/app/about/page.tsx']);
check('app pages map to routes', !s1.all && !s1.skip && s1.routes.join() === '/about,/products/:id');
const s2 = scopeFromFiles(['pages/index.tsx', 'pages/blog/[slug].tsx', 'pages/api/x.ts']);
check('pages router; api route widens to all', s2.all);
check('pages router alone', scopeFromFiles(['pages/index.tsx', 'pages/blog/[slug].tsx']).routes.join() === '/,/blog/:slug');
const s3 = scopeFromFiles(['app/blog/Comments.tsx', 'app/blog/loading.tsx']);
check('colocated files cover the folder and below', s3.routes.join() === '/blog/**');
check('root layout widens to all', scopeFromFiles(['app/layout.tsx']).all);
check('shared component widens to all', scopeFromFiles(['src/components/Button.tsx', 'docs/x.md']).all);
check('package.json widens to all', scopeFromFiles(['package.json']).all);
const s4 = scopeFromFiles(['README.md', 'docs/a.md', 'test/x.test.ts', '.github/workflows/ci.yml']);
check('docs/tests/CI only → skip', s4.skip && !s4.all);
check('no changes → skip', scopeFromFiles([]).skip);
check('mdx page under app is a route', scopeFromFiles(['app/faq/page.mdx']).routes.join() === '/faq');

check('route matching', routeMatches('/products/:id', '/products/7') && !routeMatches('/products/:id', '/products') && routeMatches('/blog/**', '/blog') && routeMatches('/blog/**', '/blog/a/b') && !routeMatches('/blog/**', '/blogger') && routeMatches('/', '/') && anyRouteMatches(['/a', '/b'], '/b/'));

const calls: string[][] = [];
const git: GitRunner = (args) => {
  calls.push(args);
  if (args[0] === 'diff' && args[2] === 'main...HEAD') return 'app/a/page.tsx\n';
  if (args[0] === 'diff') return 'app/b/page.tsx\r\n';
  return 'app/c/page.tsx\n';
};
check('changedFiles unions branch diff, uncommitted and new files', changedFiles(git, 'main').join() === 'app/a/page.tsx,app/b/page.tsx,app/c/page.tsx' && calls[0].join(' ') === 'diff --name-only main...HEAD');
let e1: unknown; try { changedFiles(git, '--output=x'); } catch (e) { e1 = e; }
check('option-looking base refused', e1 instanceof ChangeScopeError);
let e2: unknown; try { changedFiles(() => { throw new Error('not a git repository'); }, 'main'); } catch (e) { e2 = e; }
check('git failure → readable error', e2 instanceof ChangeScopeError);

(async () => {
  const okDeps = { fetchStatus: async () => 200, sleep: async () => {} };
  const never = async () => { throw new Error('should not run'); };
  const skipped = await runCi({ url: 'http://x', suite: true, check: true, changedSince: 'main' }, { ...okDeps, git: () => 'docs/a.md\n', runSuite: never, runCheck: never });
  check('docs-only diff: nothing run, exit 0, says why', skipped.exitCode === 0 && skipped.verdict === 'pass' && skipped.scope?.skip === true);
  let seen: unknown;
  await runCi({ url: 'http://x', check: true, changedSince: 'main' }, {
    ...okDeps, git: () => 'app/a/page.tsx\n',
    runCheck: async (o) => { seen = o; return ({ outcome: { verdict: 'pass', flows: [], coverage: {} }, findings: [], summary: 's', pagesChecked: 1, problems: 0, capped: false }) as never; },
  });
  check('ci passes changedSince through', (seen as { changedSince?: string }).changedSince === 'main');
  const bad3 = await runCi({ url: 'http://x', check: true, changedSince: 'main' }, { ...okDeps, git: () => { throw new Error('no git'); } });
  check('git failure → exit 3', bad3.exitCode === 3 && !!bad3.error);
  process.exit(bad ? 1 : 0);
})();
