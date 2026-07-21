import path from "node:path";
import { sha256 } from "../crypto/hash.js";
import { execFileText } from "../process/exec.js";
import { FIELD_SEP, parseSeparatedLines, redactSecrets, stripAnsi, tailLines, toNumber } from "../text/text.js";
import { DEFAULT_TMUX, type TmuxClient } from "./tmux-commands.js";
import type {
  PaneProcessInfo,
  RawTmuxClient,
  RawTmuxPane,
  RawTmuxSession,
  RawTmuxState,
  RawTmuxWindow,
  TmuxCaptureOptions
} from "./tmux-types.js";

const WINDOW_FIELDS = [
  "sessionName",
  "windowId",
  "windowIndex",
  "windowName",
  "windowActive",
  "windowPanes",
  "windowLayout",
  "windowZoomed"
];

const PANE_FIELDS = [
  "sessionName",
  "windowId",
  "paneId",
  "windowIndex",
  "windowName",
  "paneIndex",
  "paneActive",
  "windowActive",
  "currentPath",
  "currentCommand",
  "paneTitle",
  "panePid",
  "paneTty",
  "paneWidth",
  "paneHeight"
];

const SESSION_FIELDS = ["sessionName", "sessionWindows", "sessionAttached", "created"];
const CLIENT_FIELDS = ["clientName", "sessionName", "windowId", "paneId", "clientTty"];
const PANE_CAPTURE_STAGGER_MAX_MS = 40;
const paneActivity = new Map<string, { hash: string; changedAt: string }>();

type TmuxSessionRow = Omit<RawTmuxSession, "sessionWindows" | "sessionAttached"> & {
  sessionWindows: string;
  sessionAttached: string;
};

type TmuxWindowRow = Omit<RawTmuxWindow, "windowIndex" | "windowActive" | "windowPanes" | "windowZoomed"> & {
  windowIndex: string;
  windowActive: string;
  windowPanes: string;
  windowZoomed: string;
};

type TmuxPaneRow = Omit<
  RawTmuxPane,
  | "windowIndex"
  | "paneIndex"
  | "paneActive"
  | "windowActive"
  | "panePid"
  | "paneWidth"
  | "paneHeight"
  | "capture"
  | "styledCapture"
  | "captureHash"
  | "changedAt"
  | "preview"
  | "processes"
  | "foregroundProcesses"
> & {
  windowIndex: string;
  paneIndex: string;
  paneActive: string;
  windowActive: string;
  panePid: string;
  paneWidth: string;
  paneHeight: string;
};

type TmuxClientRow = RawTmuxClient;

export async function capturePanePreview(
  paneId: string,
  lines: number,
  client: TmuxClient = DEFAULT_TMUX
): Promise<string> {
  const res = await capturePane(paneId, lines, client);
  return tailLines(redactSecrets(res.plain), lines);
}

export function tmuxWindowKey(
  windowOrPane: Pick<RawTmuxWindow | RawTmuxPane, "sessionName" | "windowName">
) {
  return `${windowOrPane.sessionName}:${windowOrPane.windowName}`;
}

export async function getRawTmuxState(
  captureLines: number,
  options: TmuxCaptureOptions = {},
  client: TmuxClient = DEFAULT_TMUX
): Promise<RawTmuxState> {
  const [sessions, windows, panes, clients] = await Promise.all([
    listTmux<TmuxSessionRow>(["list-sessions"], SESSION_FIELDS, client).catch(() => []),
    listTmux<TmuxWindowRow>(["list-windows", "-a"], WINDOW_FIELDS, client).catch(() => []),
    listTmux<TmuxPaneRow>(["list-panes", "-a"], PANE_FIELDS, client).catch(() => []),
    listTmux<TmuxClientRow>(["list-clients"], CLIENT_FIELDS, client).catch(() => [])
  ]);

  const forceWindowIds = new Set<string>(options.forceWindowIds ?? []);
  const monitorWindowKeys = options.monitorWindowKeys instanceof Set ? options.monitorWindowKeys : null;
  const windowPaneCounts = new Map<string, number>(
    windows.map((window): [string, number] => [window.windowId, toNumber(window.windowPanes, 1)])
  );
  const normalizedPanes: RawTmuxPane[] = panes.map((pane) => ({
    ...pane,
    paneActive: pane.paneActive === "1",
    windowActive: pane.windowActive === "1",
    windowIndex: toNumber(pane.windowIndex),
    paneIndex: toNumber(pane.paneIndex),
    panePid: toNumber(pane.panePid),
    paneWidth: toNumber(pane.paneWidth),
    paneHeight: toNumber(pane.paneHeight),
    capture: "",
    styledCapture: "",
    captureHash: "",
    changedAt: paneActivity.get(paneActivityKey({ paneId: pane.paneId }))?.changedAt || "",
    preview: "",
    processes: [],
    foregroundProcesses: []
  }));

  prunePaneActivity(new Set(normalizedPanes.map((pane) => paneActivityKey(pane))));

  await mapLimit(normalizedPanes, 8, async (pane, index) => {
    const windowPaneCount = windowPaneCounts.get(pane.windowId) ?? 1;
    if (!shouldCapturePane(pane, windowPaneCount, forceWindowIds, monitorWindowKeys)) {
      return;
    }
    await delay(captureStaggerDelayMs(index));
    const capture = await capturePane(pane.paneId, captureLines, client);
    pane.capture = redactSecrets(capture.plain);
    pane.styledCapture = capture.styled;
    pane.processes = await listPaneProcesses(pane.paneTty, client);
    pane.foregroundProcesses = pane.processes.filter((process) => process.state.includes("+"));
    pane.captureHash = sha256(`${pane.currentPath}\n${pane.currentCommand}\n${pane.capture}\n${pane.styledCapture}`);
    pane.changedAt = updatePaneChangedAt(pane);
    pane.preview = tailLines(pane.capture, captureLines);
  });

  return {
    sessions: sessions.map((session): RawTmuxSession => ({
      ...session,
      sessionWindows: toNumber(session.sessionWindows),
      sessionAttached: toNumber(session.sessionAttached)
    })),
    windows: windows.map((window): RawTmuxWindow => ({
      ...window,
      windowIndex: toNumber(window.windowIndex),
      windowActive: window.windowActive === "1",
      windowPanes: toNumber(window.windowPanes),
      windowZoomed: window.windowZoomed === "1"
    })),
    panes: normalizedPanes,
    clients: clients.map((clientRow): RawTmuxClient => ({
      ...clientRow
    }))
  };
}

export function captureStaggerDelayMs(index: number, random = Math.random): number {
  if (index <= 0) return 0;
  return Math.floor(random() * PANE_CAPTURE_STAGGER_MAX_MS);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function format(fields: string[]) {
  return fields.map((field) => {
    const tmuxName = {
      sessionName: "session_name",
      sessionWindows: "session_windows",
      sessionAttached: "session_attached",
      created: "session_created_string",
      windowId: "window_id",
      windowIndex: "window_index",
      windowName: "window_name",
      windowActive: "window_active",
      windowPanes: "window_panes",
      windowLayout: "window_layout",
      windowZoomed: "window_zoomed_flag",
      paneId: "pane_id",
      paneIndex: "pane_index",
      paneActive: "pane_active",
      currentPath: "pane_current_path",
      currentCommand: "pane_current_command",
      paneTitle: "pane_title",
      panePid: "pane_pid",
      paneTty: "pane_tty",
      paneWidth: "pane_width",
      paneHeight: "pane_height",
      clientName: "client_name",
      clientTty: "client_tty"
    }[field];
    return `#{${tmuxName}}`;
  }).join(FIELD_SEP);
}

async function listTmux<T extends object>(
  args: string[],
  fields: string[],
  client: TmuxClient
): Promise<T[]> {
  const output = await execFileText(
    client.binary ?? "tmux",
    [...client.socketArgs, ...args, "-F", format(fields)],
    undefined,
    client.runner
  );
  return parseSeparatedLines(output, fields) as T[];
}

async function capturePane(paneId: string, captureLines: number, client: TmuxClient) {
  try {
    const styled = await execFileText(
      client.binary ?? "tmux",
      [...client.socketArgs, "capture-pane", "-t", paneId, "-e", "-p", "-S", `-${captureLines}`],
      undefined,
      client.runner
    );
    const trimmedStyled = styled.replace(/\s+$/g, "");
    return {
      plain: stripAnsi(trimmedStyled).replace(/\s+$/g, ""),
      styled: trimmedStyled
    };
  } catch {
    return { plain: "", styled: "" };
  }
}

async function mapLimit<T>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<void>) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await mapper(item, index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function shouldCapturePane(
  pane: RawTmuxPane,
  windowPaneCount: number,
  forceWindowIds = new Set<string>(),
  monitorWindowKeys: Set<string> | null = null
) {
  if (monitorWindowKeys && !monitorWindowKeys.has(tmuxWindowKey(pane)) && !forceWindowIds.has(pane.windowId)) {
    return false;
  }
  if (forceWindowIds.has(pane.windowId)) {
    return true;
  }
  if (monitorWindowKeys && monitorWindowKeys.has(tmuxWindowKey(pane))) {
    return true;
  }
  if (pane.paneActive) {
    return true;
  }
  if (pane.currentCommand && pane.currentCommand !== "zsh" && pane.currentCommand !== "bash" && pane.currentCommand !== "fish") {
    return true;
  }
  return windowPaneCount <= 2;
}

function updatePaneChangedAt(pane: RawTmuxPane) {
  const key = paneActivityKey(pane);
  if (!pane.captureHash) {
    return paneActivity.get(key)?.changedAt || "";
  }

  const existing = paneActivity.get(key);
  if (existing?.hash === pane.captureHash) {
    return existing.changedAt;
  }

  const changedAt = new Date().toISOString();
  paneActivity.set(key, {
    hash: pane.captureHash,
    changedAt
  });
  return changedAt;
}

function paneActivityKey(pane: Pick<RawTmuxPane, "paneId">) {
  return pane.paneId;
}

function prunePaneActivity(activePaneKeys: Set<string>) {
  for (const paneKey of paneActivity.keys()) {
    if (!activePaneKeys.has(paneKey)) {
      paneActivity.delete(paneKey);
    }
  }
}

async function listPaneProcesses(paneTty: string, client: TmuxClient) {
  if (!paneTty) {
    return [];
  }

  try {
    const ttyName = path.basename(paneTty);
    const output = await execFileText(
      "ps",
      ["-t", ttyName, "-o", "pid=,ppid=,state=,command="],
      undefined,
      client.runner
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line): PaneProcessInfo | null => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!match) {
          return null;
        }
        return {
          pid: toNumber(match[1]),
          ppid: toNumber(match[2]),
          state: match[3] ?? "",
          command: redactSecrets(match[4] ?? "")
        };
      })
      .filter((process): process is PaneProcessInfo => process !== null)
      .slice(0, 30);
  } catch {
    return [];
  }
}
