/* v163 — E8: API calls seen in a run vs an OpenAPI description (fixture spec, no network). */
import { checkApiCalls, OpenApiError, parseOpenApi } from '../src/openapi/check.js';

let bad = 0;
const check = (label: string, ok: boolean) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); };

const spec = JSON.stringify({
  openapi: '3.0.3',
  servers: [{ url: 'https://shop.test/api/v1' }],
  paths: {
    '/products': { get: { responses: { '200': {} } } },
    '/products/{id}': { get: { responses: { '200': {}, '404': {} } }, delete: { responses: { '2XX': {}, default: {} } } },
    '/orders': { post: { responses: { '201': {}, '400': {} } } },
  },
});
const call = (method: string, url: string, status?: number) => ({ ts: 0, method, url, ...(status !== undefined && { status }) });
const parsed = parseOpenApi(spec);

const ok = checkApiCalls(parsed, [call('GET', 'https://shop.test/api/v1/products', 200), call('GET', 'https://shop.test/api/v1/products/7', 404), call('POST', 'https://shop.test/api/v1/orders', 201)]);
check('matching calls pass', ok.mismatches.length === 0 && ok.checked === 3);

const r = checkApiCalls(parsed, [
  call('POST', 'https://shop.test/api/v1/orders', 500),
  call('PUT', 'https://shop.test/api/v1/products/7', 200),
  call('GET', 'https://shop.test/api/v1/carts', 200),
  call('DELETE', 'https://shop.test/api/v1/products/7', 503),
  call('GET', 'https://shop.test/api/v1/products', 200),
  call('GET', 'https://shop.test/api/v1/products', 200),
]);
const kinds = r.mismatches.map((m) => m.kind).sort().join();
check('finds each kind of mismatch', kinds === 'method-not-allowed,undocumented-path,undocumented-status');
check('default / 2XX documented statuses accepted', !r.mismatches.some((m) => m.method === 'DELETE'));
check('duplicates counted once per distinct call, summary plain', r.summary.startsWith('3 of'));
check('other origins and assets ignored', checkApiCalls(parsed, [call('GET', 'https://cdn.other/x.js', 200), call('GET', 'https://shop.test/logo.png', 200)]).checked === 0);

// server at the root: only api-looking paths are judged
const rootSpec = parseOpenApi(JSON.stringify({ swagger: '2.0', basePath: '/api', paths: { '/ping': { get: { responses: { '200': {} } } } } }));
const r2 = checkApiCalls(rootSpec, [call('GET', 'http://localhost:3000/api/ping', 200), call('GET', 'http://localhost:3000/api/nope', 200), call('GET', 'http://localhost:3000/about', 200)], { origin: 'http://localhost:3000' });
check('swagger 2 basePath; page loads not judged', r2.checked === 2 && r2.mismatches.length === 1 && r2.mismatches[0].path === '/nope');

let e1: unknown, e2: unknown;
try { parseOpenApi('openapi: 3.0.0'); } catch (e) { e1 = e; }
try { parseOpenApi('{"hello":1}'); } catch (e) { e2 = e; }
check('YAML / non-spec refused plainly', e1 instanceof OpenApiError && e2 instanceof OpenApiError);
process.exit(bad ? 1 : 0);
