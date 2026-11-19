
export interface Pane {
  id: string;                    // tmux pane id, e.g. "%3"
  workerId: string;
  command: string[];             // best-effort spawn command; tmux panes may start as a shell
  cwd: string;
  pid: number | null;
  spawnedAt: string;
}

export interface ViewerHandle {
  /** Resolves when the runtime has finished non-blocking attach work needed
   *  before synthetic test input can reliably expect live output. Production
   *  callers do not need to await this. */
  ready?: Promise<void>;
  detach(): void;
  resize(geometry: { cols: number; rows: number }): void;
  /** Dispatch a browser→server WS frame to the runtime. The dispatcher in
   *  terminal.ts installs a no-op `onMessage` and calls this from there
   *  — Hono's WSContext exposes no event listener API, so the runtime can't
   *  subscribe to messages itself. Frame shape: same as MessageEvent.data
   *  (string for text, ArrayBuffer for binary). Frames are handled one at a
   *  time, in order; the promise settles once this one has been. */
  handleMessage(data: unknown): Promise<void>;
}

export interface SpawnPaneInput {
  workerId: string;
  command?: string[];
  /** Where the shell starts; without it, where the worker works, read when
   *  the split runs. */
  cwd?: string;
  direction?: "right" | "down";
  targetPaneId?: string;
}

export interface ReadScrollbackOptions {
  tailLines?: number;            // default 200
}
