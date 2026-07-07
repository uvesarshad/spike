import { redactValue, type RedactionOptions } from './redaction.js';

export type SpanStatus = 'ok' | 'error';

export interface TelemetrySpan {
  name: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  events: TelemetryEvent[];
  error?: string;
}

export interface TelemetryEvent {
  name: string;
  time: string;
  attributes: Record<string, unknown>;
}

export interface TelemetryExporter {
  export(span: TelemetrySpan): void | Promise<void>;
}

export interface TelemetryTracerOptions {
  exporter?: TelemetryExporter;
  redaction?: RedactionOptions;
}

export interface ActiveSpan {
  setAttribute(key: string, value: unknown): void;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  end(attributes?: Record<string, unknown>): void;
  fail(error: unknown, attributes?: Record<string, unknown>): void;
}

export interface TelemetryTracer {
  startSpan(name: string, attributes?: Record<string, unknown>): ActiveSpan;
  trace<T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
}

export class NoopTelemetryExporter implements TelemetryExporter {
  export(): void {
    // default sink intentionally does nothing
  }
}

export class NoopTelemetryTracer implements TelemetryTracer {
  startSpan(): ActiveSpan {
    return NOOP_SPAN;
  }

  async trace<T>(_name: string, _attributes: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export function createTelemetryTracer(opts: TelemetryTracerOptions = {}): TelemetryTracer {
  if (!opts.exporter) return new NoopTelemetryTracer();
  return new ExportingTelemetryTracer(opts.exporter, opts.redaction ?? {});
}

class ExportingTelemetryTracer implements TelemetryTracer {
  constructor(
    private readonly exporter: TelemetryExporter,
    private readonly redaction: RedactionOptions,
  ) {}

  startSpan(name: string, attributes: Record<string, unknown> = {}): ActiveSpan {
    return new ExportingSpan(name, attributes, this.exporter, this.redaction);
  }

  async trace<T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const span = this.startSpan(name, attributes);
    try {
      const result = await fn();
      span.end();
      return result;
    } catch (e) {
      span.fail(e);
      throw e;
    }
  }
}

class ExportingSpan implements ActiveSpan {
  private readonly started = Date.now();
  private readonly startIso = new Date(this.started).toISOString();
  private readonly attributes: Record<string, unknown>;
  private readonly events: TelemetryEvent[] = [];
  private ended = false;

  constructor(
    private readonly name: string,
    attributes: Record<string, unknown>,
    private readonly exporter: TelemetryExporter,
    private readonly redaction: RedactionOptions,
  ) {
    this.attributes = sanitizeRecord(attributes, redaction);
  }

  setAttribute(key: string, value: unknown): void {
    if (this.ended) return;
    this.attributes[key] = sanitizeAttribute(key, value, this.redaction);
  }

  addEvent(name: string, attributes: Record<string, unknown> = {}): void {
    if (this.ended) return;
    this.events.push({
      name,
      time: new Date().toISOString(),
      attributes: sanitizeRecord(attributes, this.redaction),
    });
  }

  end(attributes: Record<string, unknown> = {}): void {
    this.finish('ok', undefined, attributes);
  }

  fail(error: unknown, attributes: Record<string, unknown> = {}): void {
    this.finish('error', error, attributes);
  }

  private finish(status: SpanStatus, error?: unknown, attributes: Record<string, unknown> = {}): void {
    if (this.ended) return;
    this.ended = true;
    Object.assign(this.attributes, sanitizeRecord(attributes, this.redaction));
    const ended = Date.now();
    const span: TelemetrySpan = {
      name: this.name,
      startTime: this.startIso,
      endTime: new Date(ended).toISOString(),
      durationMs: ended - this.started,
      status,
      attributes: this.attributes,
      events: this.events,
      error: error === undefined ? undefined : redactValue(error instanceof Error ? error.message : String(error), this.redaction) as string,
    };
    void this.exporter.export(span);
  }
}

function sanitizeRecord(input: Record<string, unknown>, opts: RedactionOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = sanitizeAttribute(key, value, opts);
  }
  return out;
}

function sanitizeAttribute(key: string, value: unknown, opts: RedactionOptions): unknown {
  const redacted = redactValue({ [key]: value }, opts) as Record<string, unknown>;
  return redacted[key];
}

const NOOP_SPAN: ActiveSpan = {
  setAttribute() {},
  addEvent() {},
  end() {},
  fail() {},
};
