export {
  findOtp,
  messageMatches,
  type EmailMessage,
  type EmailProvider,
  type EmailQuery,
  type WaitForEmailOptions,
} from './provider.js';
export { FakeLocalEmailProvider, type DeliverEmailInput } from './fake-local.js';
/* A9 (P0): ./imap.js is deliberately NOT re-exported here. This barrel is
 * reachable from driver/loop.ts, which is bundled into the in-browser engine
 * (tsup.lite.config.ts inlines EVERYTHING) — re-exporting the IMAP provider
 * would drag its `imapflow` import into a service-worker bundle that cannot
 * use it. Import it directly from './email/imap.js', from Node-only code. */
