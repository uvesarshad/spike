export interface EmailMessage {
  id: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  receivedAt: string;
}

export interface EmailQuery {
  to?: string;
  subjectIncludes?: string;
  bodyIncludes?: string;
  since?: string | Date;
}

export interface WaitForEmailOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface EmailProvider {
  name: string;
  listMessages(query?: EmailQuery): Promise<EmailMessage[]>;
  waitForMessage(query?: EmailQuery, opts?: WaitForEmailOptions): Promise<EmailMessage | null>;
}

export function findOtp(message: Pick<EmailMessage, 'subject' | 'text' | 'html'>, pattern = /\b(\d{4,8})\b/): string | null {
  const haystack = `${message.subject}\n${message.text}\n${message.html ?? ''}`;
  const match = pattern.exec(haystack);
  return match?.[1] ?? match?.[0] ?? null;
}

export function messageMatches(message: EmailMessage, query: EmailQuery = {}): boolean {
  if (query.to && message.to.toLowerCase() !== query.to.toLowerCase()) return false;
  if (query.subjectIncludes && !message.subject.toLowerCase().includes(query.subjectIncludes.toLowerCase())) return false;
  const body = `${message.text}\n${message.html ?? ''}`.toLowerCase();
  if (query.bodyIncludes && !body.includes(query.bodyIncludes.toLowerCase())) return false;
  if (query.since && Date.parse(message.receivedAt) < normalizeSince(query.since)) return false;
  return true;
}

function normalizeSince(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
