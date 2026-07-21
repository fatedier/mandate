import type { WSContext } from "hono/ws";

export interface Pane {
  id: string;                    // tmux pane id, e.g. "%3"
  featureId: string;
  command: string[];             // best-effort spawn command; tmux panes may start as a shell
  cwd: string;
  pid: number | null;
  status: "running" | "dead" | "archived";
  spawnedAt: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  diedAt?: string | null;
}

export interface ViewerHandle {
  /** Resolves when the runtime has finished non-blocking attach work needed
   *  before synthetic test input can reliably expect live output. Production
   *  callers do not need to await this. */
  ready?: Promise<void>;
  detach(): void;
  resize(geometry: { cols: number; rows: number }): void;
  /** Dispatch a browser→server WS frame to the runtime. The dispatcher in
   *  terminal.ts (T6) installs a no-op `onMessage` and calls this from there
   *  — Hono's WSContext exposes no event listener API, so the runtime can't
   *  subscribe to messages itself. Frame shape: same as MessageEvent.data
   *  (string for text, ArrayBuffer for binary). */
  handleMessage(data: unknown): void;
}

interface AttachViewerOptions {
  /** tmux-only: acquire a Web fit lease before the initial snapshot is sent,
   *  so the first paint already uses the browser-sized grid. */
  fit?: boolean;
  /** Number of scrollback rows to seed on initial attach. Tmux Web fit keeps
   *  this at 0 so reopening a terminal does not visibly replay history. */
  historyRows?: number;
}

export interface SpawnPaneInput {
  featureId: string;
  command?: string[];
  cwd: string;
  direction?: "right" | "down";
  targetPaneId?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface ReadScrollbackOptions {
  tailLines?: number;            // default 200
}

export interface PaneRuntime {
  readonly kind: "tmux";

  /** Server boot. Tmux: sweep stale sockets / fit-leases. */
  init(): Promise<Map<string, Pane[]>>;

  /** Server shutdown. */
  dispose(): Promise<void>;

  spawnPane(input: SpawnPaneInput): Promise<Pane>;
  killPane(paneId: string, signal?: NodeJS.Signals): Promise<void>;
  listPanes(featureId: string): Promise<Pane[]>;
  getPane(paneId: string): Promise<Pane | null>;
  sendKeys(paneId: string, args: string[]): Promise<void>;
  readScrollback(paneId: string, opts?: ReadScrollbackOptions): Promise<string>;
  attachViewer(
    paneId: string,
    ws: WSContext,
    geometry: { cols: number; rows: number },
    options?: AttachViewerOptions
  ): Promise<ViewerHandle>;
}
