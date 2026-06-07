/* Tiny static-file server for the on-disk buggy-shop fixture (real-files twin of
 * fixture/server.ts). The whole shop is plain files in THIS directory; the only
 * bug lives in checkout.js â€” buildOrder() omits `total`, so clicking "Place
 * order" throws `TypeError ... reading 'toFixed'` BEFORE the fetch resolves.
 *
 * The server is deliberately BUG-FREE: POST /api/order always returns 200, so
 * the only thing standing between the user and /success is that client-side
 * TypeError. Fixing it is therefore a one-file, one-line edit (add `total` to
 * the object buildOrder returns) â€” graspable from the fix prompt alone.
 *
 * A `BUG` marker file in this directory is honoured for parity with the
 * in-memory fixture's bug toggle, but its only effect is cosmetic: when present
 * the /api/order response notes the marker. The order endpoint NEVER 500s â€” the
 * client crash is the sole failure mode. */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default document root = this directory (the pristine repo fixture). The
 * auto-fix e2e overrides this with a temp COPY so the agent's edits are the ones
 * actually served. */
const DEFAULT_ROOT = path.dirname(fileURLToPath(import.meta.url));

const ROUTES: Record<string, string> = {
  '/': 'login.html',
  '/login': 'login.html',
  '/products': 'products.html',
  '/cart': 'cart.html',
  '/checkout': 'checkout.html',
  '/success': 'success.html',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

/** A `BUG` marker file is purely informational here â€” the server stays 200. */
function bugMarkerPresent(root: string): boolean {
  return fs.existsSync(path.join(root, 'BUG'));
}

/** Resolve a request URL to an on-disk file inside `root`, or null if it escapes
 * the directory / does not exist. */
function resolveFile(root: string, url: string): string | null {
  const clean = url.split('?')[0];
  const rel = ROUTES[clean] ?? clean.replace(/^\/+/, '');
  if (!rel) return null;
  const full = path.resolve(root, rel);
  if (!full.startsWith(root)) return null; // path-traversal guard
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
}

/**
 * Start the buggy-shop server.
 * @param port  TCP port (9421 in the e2e).
 * @param root  Document root. Defaults to the repo fixture; the auto-fix e2e
 *              passes a temp COPY so the AGENT's edits are what gets served
 *              (the repo copy stays pristine). THIS is essential: the agent
 *              edits files under `root`, and the re-test must serve them.
 */
export function startBuggyShop(port: number, root: string = DEFAULT_ROOT): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    // Order endpoint: always succeeds (200). The client crashes before this
    // ever matters in bug mode, so the fix is purely client-side.
    if (url.split('?')[0] === '/api/order' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, bugMarker: bugMarkerPresent(root) }));
      });
      return;
    }

    const file = resolveFile(root, url);
    if (!file) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain');
      res.end('Not found');
      return;
    }
    res.statusCode = 200;
    const ext = path.extname(file);
    res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
    // No caching: the auto-fix loop edits checkout.js between runs, so the
    // re-run MUST fetch the freshly-edited file, not a stale Chrome cache copy.
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');

    if (ext === '.html') {
      // Belt-and-braces over `no-store`: stamp every local <script src> with the
      // referenced file's current mtime, so once the agent edits checkout.js the
      // URL changes (?v=<mtime>) and Chrome's resource cache CANNOT serve a stale
      // copy on the re-run. (Chrome's nav/memory cache has been observed to keep
      // a script across same-session tabs despite no-store.)
      const html = fs.readFileSync(file, 'utf8').replace(
        /src="\/([\w.-]+\.js)"/g,
        (_m, name: string) => {
          const target = path.resolve(root, name);
          const v = fs.existsSync(target) ? fs.statSync(target).mtimeMs : Date.now();
          return `src="/${name}?v=${Math.round(v)}"`;
        },
      );
      res.end(html);
      return;
    }
    res.end(fs.readFileSync(file));
  });
  server.listen(port);
  return server;
}

/** Close immediately, severing Chrome's keep-alive sockets (a bare close()
 * waits on them forever). */
export function stopBuggyShop(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

// Run standalone: `npx tsx serve.ts [port]`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('serve.ts')) {
  const port = Number(process.argv[2] ?? 9421);
  startBuggyShop(port);
  console.log(`buggy-shop serving on http://localhost:${port}/login (root ${DEFAULT_ROOT})`);
}
