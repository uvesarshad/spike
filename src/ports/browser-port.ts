/* BrowserPort — the seam between the engine and whatever drives Chrome.
 * CdpBrowser (plain CDP, --remote-debugging-port) is the MVP implementation;
 * ExtensionBrowser (MV3 chrome.debugger) implements the same contract in the
 * vibe-mode milestone. The engine must only ever import this interface. */

export interface AxNode {
  /** Per-snapshot stable id the planner references in actions (e.g. "n7"). */
  id: string;
  role: string;
  name?: string;
  value?: string;
  /** Notable states: disabled, focused, required, checked… */
  states?: string[];
  children?: AxNode[];
}

export interface AxSnapshot {
  root: AxNode;
  /** Compact indented text handed to the planner (~800 tokens target). */
  text: string;
  /** True when the serialization was truncated to fit the token guard. */
  truncated: boolean;
}

export interface ConsoleEntry {
  ts: number;
  /** log | info | warn | error | page-error */
  level: string;
  text: string;
}

export interface NetworkEntry {
  ts: number;
  method: string;
  url: string;
  status?: number;
  ms?: number;
  failed?: boolean;
  errorText?: string;
}

export interface LogpointSpec {
  /** Script URL the logpoint targets. */
  url: string;
  /** Line located by content, never by hardcoded number. */
  lineContains: string;
  /** Expression whose value gets console.log'd (variables in scope at that line). */
  expression: string;
}

export interface BrowserPort {
  launch(): Promise<void>;
  navigate(url: string): Promise<void>;
  url(): Promise<string>;
  /** Snapshot the accessibility tree; refreshes the nodeId map used by click/type. */
  axTree(): Promise<AxSnapshot>;
  click(nodeId: string): Promise<void>;
  type(nodeId: string, text: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  setLogpoint(spec: LogpointSpec): Promise<void>;
  /** Everything captured since the previous drain — per-step evidence correlation. */
  drainConsole(): ConsoleEntry[];
  drainNetwork(): NetworkEntry[];
  close(): Promise<void>;
}
