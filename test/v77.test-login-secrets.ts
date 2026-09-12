/**
 * V77 — the side panel may store a test login, and nothing else (audit A5).
 *
 * The panel's "Test login (optional)" card is what stops people typing a real
 * password into the task box. It needs to put a value into the encrypted store
 * on the user's machine — but that same store holds their API keys, so the two
 * new bridge methods are restricted to exactly two names, the same way the
 * key methods are restricted to known providers.
 *
 * This suite pins the allow-list: TEST_USER and TEST_PASSWORD are accepted, and
 * every other name is refused BEFORE the store is opened (so a rejected call
 * cannot read, overwrite or delete anything).
 *
 * Pure/in-memory: a stub bridge records the registered handlers and they are
 * called directly. No socket, no Chrome, no vault write.
 *
 * Run: npx tsx test/v77.test-login-secrets.ts
 */

import assert from 'node:assert/strict';
import type { BridgeServer } from '../src/bridge/bridge-server.js';
import { VibeService, isTestLoginSecretName } from '../src/vibe/service.js';

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`PASS ${name}`),
      (e) => {
        failures++;
        console.error(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
      },
    );
}

type Handler = (params: unknown, ctx: { clientId: number }) => Promise<unknown>;

/** Records what VibeService registers; answers "yes" to the paired-client check
 * so the test exercises the NAME gate rather than the authentication gate. */
function stubBridge() {
  const handlers = new Map<string, Handler>();
  const bridge = {
    onEvent() {},
    onRequest(method: string, handler: Handler) {
      handlers.set(method, handler);
    },
    isAuthenticated() {
      return true;
    },
    sendEvent() {},
    async call() {
      return {};
    },
  };
  return { bridge: bridge as unknown as BridgeServer, handlers };
}

const { bridge, handlers } = stubBridge();
new VibeService(bridge).start();

const REJECTED = [
  'anthropic', // an API key — the thing this must never be able to overwrite
  'openai',
  'gemini',
  'TEST_USERS',
  'test_user', // case matters
  'TEST_PASSWORD ',
  '',
  '__proto__',
  '../../etc/passwd',
];

await check('both methods are registered', () => {
  assert.ok(handlers.has('vibe.secret.set'), 'vibe.secret.set must exist');
  assert.ok(handlers.has('vibe.secret.clear'), 'vibe.secret.clear must exist');
});

await check('only the two test-login names are recognised', () => {
  assert.ok(isTestLoginSecretName('TEST_USER'));
  assert.ok(isTestLoginSecretName('TEST_PASSWORD'));
  for (const name of REJECTED) {
    assert.ok(!isTestLoginSecretName(name), `"${name}" must not be storable`);
  }
  for (const name of [undefined, null, 42, {}, ['TEST_USER']]) {
    assert.ok(!isTestLoginSecretName(name), `${JSON.stringify(name)} must not be storable`);
  }
});

await check('storing any other name is refused before the store is opened', async () => {
  const set = handlers.get('vibe.secret.set')!;
  for (const name of REJECTED) {
    await assert.rejects(
      () => set({ name, value: 'whatever' }, { clientId: 1 }),
      /only the test-login fields/,
      `"${name}" was not refused`,
    );
  }
});

await check('clearing any other name is refused too', async () => {
  const clear = handlers.get('vibe.secret.clear')!;
  for (const name of REJECTED) {
    await assert.rejects(
      () => clear({ name }, { clientId: 1 }),
      /only the test-login fields/,
      `clearing "${name}" was not refused`,
    );
  }
});

await check('an empty value is refused for an allowed name', async () => {
  const set = handlers.get('vibe.secret.set')!;
  await assert.rejects(() => set({ name: 'TEST_PASSWORD', value: '' }, { clientId: 1 }), /non-empty/);
  await assert.rejects(() => set({ name: 'TEST_USER' }, { clientId: 1 }), /non-empty/);
});

await check('an unpaired caller cannot store a test login at all', async () => {
  const { bridge: closed, handlers: closedHandlers } = stubBridge();
  (closed as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => false;
  new VibeService(closed).start();
  await assert.rejects(
    () => closedHandlers.get('vibe.secret.set')!({ name: 'TEST_USER', value: 'someone' }, { clientId: 2 }),
    /unauthenticated/,
  );
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nV77 OK');
