/* A9 (P0) — a REAL inbox provider, over plain IMAP.
 *
 * Signup, password-reset and magic-link flows all end in an email, so a QA
 * agent that cannot read one cannot finish them. The only provider before this
 * was an in-memory test double, which meant `wait_for_email` could never work
 * against a real app.
 *
 * IMAP on purpose, not a disposable-inbox SaaS: it works with the mailbox the
 * user already has (a Gmail app password, Fastmail, a self-hosted server, or a
 * catch-all domain), costs nothing, adds no third party to the trust boundary,
 * and keeps every message on the user's own server. The trade is setup — a
 * host, a user and an app password.
 *
 * `imapflow` is an OPTIONAL dependency: most runs never touch email, and a
 * hard dependency would make every install pay for it. It is imported lazily,
 * so a missing package surfaces as one clear sentence at the moment email is
 * actually used, not as a startup crash for everyone.
 *
 * Deliberately read-only: messages are fetched and never flagged, moved or
 * deleted. A QA run must not mutate a real mailbox.
 */

import {
  messageMatches,
  type EmailMessage,
  type EmailProvider,
  type EmailQuery,
  type WaitForEmailOptions,
} from './provider.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ImapEmailProviderOptions {
  host: string;
  user: string;
  /** Resolved plaintext, held in memory only — the caller reads it from the
   * vault (or the environment) and never writes it to disk or a report. */
  pass: string;
  /** Default 993 (implicit TLS). */
  port?: number;
  /** Default true; set false only for a local test server. */
  secure?: boolean;
  /** Default 'INBOX'. */
  mailbox?: string;
  /** How many of the most recent messages to consider per poll. Small on
   * purpose: a verification email is always the newest thing in the box, and
   * a big fetch against a years-old mailbox is slow for no benefit. */
  fetchLimit?: number;
}

/** Minimal shape of the bits of an ImapFlow client this provider uses — kept
 * local so the module type-checks with the optional package absent. */
interface ImapLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close?(): void;
  mailboxOpen(mailbox: string, opts?: { readOnly?: boolean }): Promise<{ exists: number }>;
  fetch(range: string, query: Record<string, boolean>): AsyncIterable<ImapFetchedMessage>;
}

interface ImapFetchedMessage {
  uid?: number;
  envelope?: {
    subject?: string;
    date?: Date;
    from?: Array<{ address?: string }>;
    to?: Array<{ address?: string }>;
  };
  source?: Uint8Array | { toString(encoding?: string): string };
}

export const IMAPFLOW_MISSING_MESSAGE =
  'Reading email needs the optional "imapflow" package — install it with: npm install imapflow';

/** Reads a real mailbox over IMAP. One short-lived connection per poll: a QA
 * run polls a handful of times over a couple of minutes, and a connection held
 * open across that is a connection to drop, re-authenticate and babysit. */
export class ImapEmailProvider implements EmailProvider {
  readonly name = 'imap';

  constructor(private readonly opts: ImapEmailProviderOptions) {}

  /** Newest-first, already filtered by `query`. */
  async listMessages(query: EmailQuery = {}): Promise<EmailMessage[]> {
    const messages = await this.fetchRecent();
    return messages.filter((message) => messageMatches(message, query));
  }

  /** Polls until a matching message shows up or the deadline passes. The
   * default 60s beats the 30s the driver's `wait_for_email` uses by default —
   * real mail servers are slower than a local fake, and the driver's own
   * timeout is the one that actually bounds the step. */
  async waitForMessage(query: EmailQuery = {}, opts: WaitForEmailOptions = {}): Promise<EmailMessage | null> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [first] = await this.listMessages(query);
      if (first) return first;
      if (Date.now() >= deadline) return null;
      await sleep(intervalMs);
    }
  }

  /** One connect → open read-only → fetch the tail → disconnect cycle. */
  private async fetchRecent(): Promise<EmailMessage[]> {
    const client = await this.connect();
    const out: EmailMessage[] = [];
    try {
      const mailbox = await client.mailboxOpen(this.opts.mailbox ?? 'INBOX', { readOnly: true });
      const total = mailbox.exists ?? 0;
      if (!total) return out;
      const limit = this.opts.fetchLimit ?? 20;
      const from = Math.max(1, total - limit + 1);
      for await (const raw of client.fetch(`${from}:*`, { envelope: true, source: true })) {
        out.push(toEmailMessage(raw));
      }
    } finally {
      await client.logout().catch(() => client.close?.());
    }
    // newest first — messageMatches()/findOtp() callers want the latest email
    return out.reverse();
  }

  private async connect(): Promise<ImapLike> {
    const { ImapFlow } = await loadImapFlow();
    const client = new ImapFlow({
      host: this.opts.host,
      port: this.opts.port ?? 993,
      secure: this.opts.secure ?? true,
      auth: { user: this.opts.user, pass: this.opts.pass },
      // the library's own console chatter would land in the daemon's output
      // and, worse, echo message headers into it
      logger: false,
    }) as ImapLike;
    await client.connect();
    return client;
  }
}

/** Lazy, so the optional package is only required by runs that read email.
 *
 * The specifier is held in a variable ON PURPOSE: a literal would make
 * TypeScript demand the package's type declarations — and a bundler try to
 * inline it — at build time, on every machine, for a dependency most installs
 * legitimately do not have. This keeps "optional" actually optional. */
const IMAPFLOW_MODULE = 'imapflow';

async function loadImapFlow(): Promise<{ ImapFlow: new (opts: unknown) => unknown }> {
  try {
    return (await import(IMAPFLOW_MODULE)) as unknown as { ImapFlow: new (opts: unknown) => unknown };
  } catch {
    throw new Error(IMAPFLOW_MISSING_MESSAGE);
  }
}

/** IMAP envelope + raw source → the transport-neutral EmailMessage the driver
 * understands. The body is taken from the raw source's text after the header
 * block: good enough to find a code or a link, and it needs no MIME parser
 * (another dependency) to work on the overwhelmingly common single-part and
 * simple-multipart verification email. */
export function toEmailMessage(raw: ImapFetchedMessage): EmailMessage {
  const envelope = raw.envelope ?? {};
  const source = raw.source ? Buffer.from(raw.source as Uint8Array).toString('utf8') : '';
  const body = bodyOf(source);
  return {
    id: String(raw.uid ?? `${envelope.subject ?? ''}-${envelope.date?.toISOString() ?? ''}`),
    to: envelope.to?.[0]?.address ?? '',
    from: envelope.from?.[0]?.address ?? '',
    subject: envelope.subject ?? '',
    text: body,
    receivedAt: (envelope.date ?? new Date()).toISOString(),
  };
}

/** Everything after the first blank line — the headers are already in the
 * envelope, and keeping them would make every OTP regex match a message-id. */
function bodyOf(source: string): string {
  const split = source.indexOf('\r\n\r\n');
  if (split >= 0) return source.slice(split + 4);
  const lfSplit = source.indexOf('\n\n');
  return lfSplit >= 0 ? source.slice(lfSplit + 2) : source;
}
