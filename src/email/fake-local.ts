import {
  messageMatches,
  type EmailMessage,
  type EmailProvider,
  type EmailQuery,
  type WaitForEmailOptions,
} from './provider.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface DeliverEmailInput {
  to: string;
  from?: string;
  subject: string;
  text: string;
  html?: string;
  receivedAt?: string | Date;
}

export class FakeLocalEmailProvider implements EmailProvider {
  readonly name = 'fake-local';
  private messages: EmailMessage[] = [];
  private nextId = 1;

  deliver(input: DeliverEmailInput): EmailMessage {
    const message: EmailMessage = {
      id: `local-${this.nextId++}`,
      to: input.to,
      from: input.from ?? 'no-reply@example.test',
      subject: input.subject,
      text: input.text,
      ...(input.html && { html: input.html }),
      receivedAt: normalizeTime(input.receivedAt),
    };
    this.messages.push(message);
    return message;
  }

  clear(): void {
    this.messages = [];
    this.nextId = 1;
  }

  async listMessages(query: EmailQuery = {}): Promise<EmailMessage[]> {
    return this.messages.filter((message) => messageMatches(message, query));
  }

  async waitForMessage(query: EmailQuery = {}, opts: WaitForEmailOptions = {}): Promise<EmailMessage | null> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const intervalMs = opts.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [first] = await this.listMessages(query);
      if (first) return first;
      if (Date.now() >= deadline) return null;
      await sleep(intervalMs);
    }
  }
}

function normalizeTime(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
}
