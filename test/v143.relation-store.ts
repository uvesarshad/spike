/* v143 — A10: relations that held in a passing run persist per host. Temp dir; no browser.
 * Run: npx tsx test/v143.relation-store.ts */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRelationsFor, saveRelationsFor, savedRelationIds } from '../src/assertions/relation-store.js';

const checks: [string, boolean][] = [];
const check = (l: string, ok: boolean) => { checks.push([l, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v143-'));

check('nothing saved at first', loadRelationsFor('https://shop.example.test/cart', root).length === 0);
const added = saveRelationsFor('https://shop.example.test/cart', [{ id: 'add-item-increments-count' }, { id: 'sort-preserves-set' }], root);
check('a passing run persists its relations', added.length === 2 && fs.existsSync(path.join(root, '.spike', 'relations.json')));
check('a later run of the same host receives them', loadRelationsFor('https://shop.example.test/checkout', root).map((r) => r.relation.id).sort().join() === 'add-item-increments-count,sort-preserves-set');
check('www. and bare host are the same site', savedRelationIds('https://www.shop.example.test/', root).size === 2);
check('a different host does not', loadRelationsFor('https://other.example.test/', root).length === 0);
check('saving again adds nothing', saveRelationsFor('https://shop.example.test/', [{ id: 'sort-preserves-set' }], root).length === 0);
check('unknown relation ids are ignored on load', (() => { saveRelationsFor('https://x.test/', [{ id: 'nope' }], root); return loadRelationsFor('https://x.test/', root).length === 0; })());
fs.writeFileSync(path.join(root, '.spike', 'relations.json'), '{bad');
check('a corrupt file means nothing saved, not a crash', loadRelationsFor('https://shop.example.test/', root).length === 0);

fs.rmSync(root, { recursive: true, force: true });
const failed = checks.filter(([, ok]) => !ok);
if (failed.length) { console.error(`${failed.length} failed`); process.exit(1); }
console.log(`\nV143 checks passed (${checks.length}).`);
