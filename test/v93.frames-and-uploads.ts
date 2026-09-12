/* v93 — A23 (P1): see inside embedded frames, and stop failing every upload.
 *
 * Two dead ends that stop a real flow cold:
 *   1. the page stopped at the border of any frame running in its own process —
 *      payment forms, hosted sign-in, chat widgets, CAPTCHA — so the whole
 *      checkout or login behind one was invisible;
 *   2. a file picker asks for a path on the machine running the test, which no
 *      model can possibly know, so it invented one, the upload failed, and the
 *      flow died there.
 *
 * Covers (pure — no Chrome, no network: the browser connection is a stub):
 *   - a child frame's contents are spliced under the element that hosts it,
 *     labelled with the frame's host, with numbering that stays unique across
 *     the whole page;
 *   - a frame that has gone away, or that this connection can't reach, leaves
 *     the page exactly as it was;
 *   - a requested upload path that doesn't exist is stood in for by a real,
 *     plausible sample file of the matching kind;
 *   - a path that DOES exist is passed through untouched.
 *
 * Run: npx tsx test/v93.frames-and-uploads.ts   (exits nonzero on any failed check)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotAxTree } from '../src/capture/axtree.js';
import { provisionUploadPaths } from '../src/driver/loop.js';
import type CDP from 'chrome-remote-interface';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/** Raw accessibility nodes for the main page: a checkout with an <iframe>. */
const PAGE_NODES = [
  { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Checkout' }, childIds: ['2', '3'], backendDOMNodeId: 1 },
  { nodeId: '2', ignored: false, role: { value: 'heading' }, name: { value: 'Pay for your order' }, parentId: '1', backendDOMNodeId: 2 },
  // the <iframe> element itself: no accessible name, so without the splice it
  // collapses away entirely
  { nodeId: '3', ignored: false, role: { value: 'Iframe' }, name: { value: '' }, parentId: '1', backendDOMNodeId: 42 },
];

/** …and for what lives inside the frame. */
const FRAME_NODES = [
  { nodeId: 'f1', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Payment' }, childIds: ['f2', 'f3'], backendDOMNodeId: 100 },
  { nodeId: 'f2', ignored: false, role: { value: 'textbox' }, name: { value: 'Card number' }, parentId: 'f1', backendDOMNodeId: 101 },
  { nodeId: 'f3', ignored: false, role: { value: 'button' }, name: { value: 'Pay $49.99' }, parentId: 'f1', backendDOMNodeId: 102 },
];

/** A stub browser connection: answers the two accessibility calls and the
 * "which element hosts this frame?" lookup, and refuses everything else the
 * way a real page mid-navigation would. */
function stubClient(opts: { frameReachable?: boolean; ownerKnown?: boolean } = {}): CDP.Client {
  const { frameReachable = true, ownerKnown = true } = opts;
  return {
    Accessibility: {
      async getFullAXTree(params?: { frameId?: string }) {
        if (params?.frameId) {
          if (!frameReachable) throw new Error('No frame with given id found');
          return { nodes: FRAME_NODES };
        }
        return { nodes: PAGE_NODES };
      },
    },
    DOM: {
      async getDocument() {
        throw new Error('no document'); // no test attributes in this fixture
      },
      async getFrameOwner() {
        if (!ownerKnown) throw new Error('Frame with the given id was not found');
        return { backendNodeId: 42 };
      },
    },
  } as unknown as CDP.Client;
}

const FRAME = { frameId: 'FRAME-1', url: 'https://checkout.payments.example/embed?k=1' };

console.log('=== v93 1/3: what is inside an embedded frame becomes part of the page ===');
{
  const { snapshot, nodeMap } = await snapshotAxTree(stubClient(), { frames: [FRAME] });

  check('the frame is labelled by its host', snapshot.text.includes('[frame: checkout.payments.example]'));
  check('what is inside it is now visible', snapshot.text.includes('Card number') && snapshot.text.includes('Pay $49.99'));
  check('the element hosting the frame survives instead of collapsing away', snapshot.text.includes('Iframe'));

  // the frame's contents must hang UNDER the element that hosts it, not float
  // at the end of the page
  const lines = snapshot.text.split('\n');
  const hostLine = lines.findIndex((l) => l.includes('Iframe'));
  const markerLine = lines.findIndex((l) => l.includes('[frame:'));
  const cardLine = lines.findIndex((l) => l.includes('Card number'));
  const indent = (l: string) => l.length - l.trimStart().length;
  check('the frame marker sits under the element hosting it', hostLine >= 0 && markerLine === hostLine + 1 && indent(lines[markerLine]) > indent(lines[hostLine]));
  check('the frame contents sit under the marker', cardLine > markerLine && indent(lines[cardLine]) > indent(lines[markerLine]));

  const ids = [...snapshot.text.matchAll(/^\s*(n\d+)\b/gm)].map((m) => m[1]);
  check('every id in the page is still unique', new Set(ids).size === ids.length);
  check('ids inside the frame resolve to real elements', [...nodeMap.values()].includes(101) && [...nodeMap.values()].includes(102));
}

console.log('\n=== v93 2/3: a frame that cannot be reached changes nothing ===');
{
  const plain = await snapshotAxTree(stubClient(), {});
  const unreachable = await snapshotAxTree(stubClient({ frameReachable: false }), { frames: [FRAME] });
  const ownerGone = await snapshotAxTree(stubClient({ ownerKnown: false }), { frames: [FRAME] });

  check('no frames asked for → the page is exactly as before', !plain.snapshot.text.includes('[frame:'));
  check('a frame this connection cannot read is simply skipped', !unreachable.snapshot.text.includes('[frame:'));
  check('…and the rest of the page still comes through', unreachable.snapshot.text.includes('Pay for your order'));
  check('a frame whose host element is gone is skipped too', !ownerGone.snapshot.text.includes('[frame:'));
}

console.log('\n=== v93 3/3: a sample file for every upload ===');
{
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-run-'));

  const cases: [string, string, (b: Buffer) => boolean][] = [
    ['a picture', '/home/nobody/avatar.png', (b) => b.subarray(1, 4).toString() === 'PNG'],
    ['a document', 'C:/fake/receipt.pdf', (b) => b.subarray(0, 5).toString() === '%PDF-'],
    ['a spreadsheet', './data/contacts.csv', (b) => b.toString().includes('name,email,amount')],
    ['anything else', '/tmp/notes.txt', (b) => b.length > 0],
    ['an unknown kind', '/tmp/thing.xyzzy', (b) => b.length > 0],
  ];

  for (const [label, requested, looksRight] of cases) {
    const [provisioned] = provisionUploadPaths([requested], runDir);
    const exists = fs.existsSync(provisioned);
    check(`${label}: a real file is created`, exists);
    check(`${label}: it is the right kind of file`, exists && looksRight(fs.readFileSync(provisioned)));
    check(`${label}: it lives under this run's own folder`, provisioned.startsWith(runDir));
  }

  const jpg = provisionUploadPaths(['/nope/photo.jpg'], runDir)[0];
  check('a JPEG request is served by the picture sample', fs.readFileSync(jpg).subarray(1, 4).toString() === 'PNG');

  // a path that really exists is left alone
  const real = path.join(runDir, 'their-own-file.csv');
  fs.writeFileSync(real, 'a,b\n1,2\n');
  check('a path that really exists is passed through untouched', provisionUploadPaths([real], runDir)[0] === real);

  // several at once, mixed
  const mixed = provisionUploadPaths([real, '/nope/scan.pdf'], runDir);
  check('a mixed list keeps the real one and stands in for the rest', mixed[0] === real && fs.existsSync(mixed[1]) && mixed[1] !== '/nope/scan.pdf');

  fs.rmSync(runDir, { recursive: true, force: true });
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
