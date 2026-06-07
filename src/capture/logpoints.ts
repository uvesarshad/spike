/* CDP logpoints — Spike B's core trick, lifted from spikes/cdp-logpoint/spike.js:
 * Debugger.setBreakpointByUrl with a condition of `console.log(...), false`
 * never pauses, only logs — runtime instrumentation with ZERO source edits.
 * Lines are located by content, never hardcoded (CLAUDE.md rule). */

import type CDP from 'chrome-remote-interface';
import type { LogpointSpec } from '../ports/browser-port.js';

export interface LogpointHandle {
  breakpointId: string;
  line: number; // 0-based resolved line
}

export async function setLogpointByContent(
  client: CDP.Client,
  spec: LogpointSpec,
): Promise<LogpointHandle> {
  // fetch the script source so the line can be found by content
  const { result } = await client.Runtime.evaluate({
    expression: `fetch(${JSON.stringify(spec.url)}).then(r => r.text())`,
    awaitPromise: true,
    returnByValue: true,
  });
  const source = result.value as string;
  if (typeof source !== 'string') throw new Error(`could not fetch source of ${spec.url}`);

  const line = source.split('\n').findIndex((l) => l.includes(spec.lineContains));
  if (line < 0) throw new Error(`no line containing ${JSON.stringify(spec.lineContains)} in ${spec.url}`);

  const bp = await client.Debugger.setBreakpointByUrl({
    url: spec.url,
    lineNumber: line,
    condition: `console.log('[LOGPOINT]', ${spec.expression}), false`,
  });
  if (bp.locations.length === 0) {
    throw new Error(`logpoint at ${spec.url}:${line + 1} resolved to 0 locations (script not loaded?)`);
  }
  return { breakpointId: bp.breakpointId, line };
}
