/* M1 verification — runs the BrowserPort port-contract suite against CdpBrowser
 * (throwaway headless Chrome on CDP 9323, mkdtemp profile). Thin runner: it
 * constructs the port, delegates the 8 checks to runPortContract, and exits
 * nonzero on any failure. The contract itself lives in port-contract.ts so any
 * BrowserPort implementation (e.g. ExtensionBrowser) can reuse it. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpBrowser } from '../src/ports/cdp-browser.js';
import { runPortContract } from './port-contract.js';

const HTTP_PORT = 9402; // scratch port, not the daemon's
const CDP_PORT = 9323; // throwaway headless chrome, not the daemon's 9322

const browser = new CdpBrowser({
  port: CDP_PORT,
  profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m1-')),
  headless: true,
});

const results = await runPortContract(browser, { label: 'CdpBrowser', httpPort: HTTP_PORT });

const failed = results.filter((r) => !r.ok);
process.exit(failed.length ? 1 : 0);
