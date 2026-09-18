import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, Profiler, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { useShallow } from "zustand/react/shallow";
import { selectSnapshotWindow } from "../src/client/lib/snapshot-selectors";
import { useSnapshotStore, type Snapshot } from "../src/client/store/snapshot";
import type { Feature } from "../src/client/store/projects";
import { FeatureCard } from "../src/client/routes/projects/FeatureCard";
import { selectTerminalPane } from "../src/client/routes/terminal/terminal-helpers";
import { SnapshotStreamEncoder } from "../src/server/modules/sse/snapshot-stream-encoder";
import { WorkspaceSnapshotDecoder } from "../src/shared/workspace-snapshot";
import { workspaceSnapshot } from "./helpers/workspace-snapshot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const original = useSnapshotStore.getState();
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  useSnapshotStore.setState({ ...original, snapshot: null }, true);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  useSnapshotStore.setState(original, true);
});
const render = (node: ReactNode) => act(async () => { root.render(node); });

function stream() {
  const snapshot = workspaceSnapshot();
  const encoder = new SnapshotStreamEncoder();
  const decoder = new WorkspaceSnapshotDecoder();
  return {
    snapshot,
    async send() {
      const frame = encoder.encode(snapshot);
      const data = JSON.parse(frame.data);
      const decoded = frame.event === "snapshotFull" ? decoder.full(data) : decoder.patch(data);
      await act(async () => { useSnapshotStore.getState().setSnapshot(decoded as Snapshot); });
      return frame.event;
    }
  };
}

test("cards only render when their own displayed status changes", async () => {
  const s = stream();
  await s.send();
  const commits = [0, 0];
  await render(<MemoryRouter>{[0, 1].map((index) => (
    <Profiler key={index} id={String(index)} onRender={() => { commits[index]!++; }}>
      <FeatureCard variant="untracked" projectSlug="alpha" item={null}
        feature={{ id: String(index), name: `Worker ${index}`, tmuxWindowName: `worker-${index}` } as Feature} />
    </Profiler>
  ))}</MemoryRouter>);
  expect(commits).toEqual([1, 1]);
  for (let index = 0; index < 10; index++) {
    s.snapshot.sessions[0]!.windows[0]!.panes![0]!.preview = `Output ${index}`;
    expect(await s.send()).toBe("snapshotPatch");
  }
  s.snapshot.sessions[0]!.windows[0]!.aggregate = { status: "running_service" };
  await s.send();
  // A different wire status can still represent the same dot.
  expect(commits).toEqual([1, 1]);
  s.snapshot.sessions[0]!.windows[0]!.aggregate = { status: "done" };
  await s.send();
  expect(commits).toEqual([2, 1]);
  expect(host.querySelectorAll('[aria-label="pane idle"]')).toHaveLength(1);
  expect(host.querySelectorAll('[aria-label="pane running"]')).toHaveLength(1);
  s.snapshot.sessions[0]!.windows.shift();
  await s.send();
  expect(commits).toEqual([3, 1]);
  expect(host.querySelectorAll('[aria-label="pane idle"]')).toHaveLength(0);
});

test("Worker subscriptions preserve loading, removal, reappearance and route changes", async () => {
  const s = stream();
  let renders = 0;
  function Worker({ session = "alpha", name = "worker-0" }) {
    const window = useSnapshotStore((state) => selectSnapshotWindow(state.snapshot, session, name));
    renders++;
    return <output>{window === undefined ? "loading" : window === null ? "missing" : window.panes?.[0]?.preview}</output>;
  }
  await render(<Worker />);
  expect(host.textContent).toBe("loading");
  await s.send();
  expect(host.textContent).toContain("alpha-0 output");
  const initial = renders;
  s.snapshot.sessions[1]!.windows[0]!.panes![0]!.preview = "Other session";
  s.snapshot.sessions[0]!.windows[1]!.panes![0]!.preview = "Other window";
  await s.send();
  expect(renders).toBe(initial);
  const window = s.snapshot.sessions[0]!.windows.shift()!;
  await s.send();
  expect(host.textContent).toBe("missing");
  s.snapshot.sessions[0]!.windows.unshift(window);
  window.panes![0]!.preview = "Restored";
  await s.send();
  expect(host.textContent).toBe("Restored");
  await render(<Worker name="worker-1" />);
  expect(host.textContent).toBe("Other window");
  await render(<Worker session="beta" />);
  expect(host.textContent).toBe("Other session");
});

test("Terminal ignores preview and sibling updates but follows visible metadata", async () => {
  const s = stream();
  const window = s.snapshot.sessions[0]!.windows[0]!;
  const panes = window.panes as Array<Record<string, unknown>>;
  const pane = panes[0]!;
  Object.assign(pane, { currentCommand: "zsh", currentPath: "/tmp/initial", paneWidth: 80, paneHeight: 24 });
  panes.push({ paneId: "%sibling", preview: "Sibling output" });
  await s.send();
  let renders = 0;
  function Terminal() {
    const selected = useSnapshotStore(useShallow((state) => selectTerminalPane(state.snapshot, "alpha", "worker-0", "%0")));
    renders++;
    return <output>{JSON.stringify(selected)}</output>;
  }
  await render(<Terminal />);
  const initial = renders;
  for (let index = 0; index < 10; index++) {
    pane.preview = `Preview ${index}`;
    window.panes![1]!.preview = `Sibling ${index}`;
    expect(await s.send()).toBe("snapshotPatch");
  }
  expect(renders).toBe(initial);
  for (const [change, field, expected] of [
    [{ currentPath: "/tmp/new" }, "currentPath", "/tmp/new"],
    [{ currentCommand: "bash" }, "currentCommand", "bash"],
    [{ paneWidth: 120 }, "paneWidth", 120],
    [{ paneHeight: 40 }, "paneHeight", 40],
    [{ foregroundProcesses: [{ pid: 1, command: "vim" }] }, "title", "vim"],
    [{ metadata: { name: "Editor", description: "", updatedAt: "now" } }, "title", "Editor"]
  ] as const) {
    const before = renders;
    Object.assign(pane, change);
    await s.send();
    expect(renders).toBe(before + 1);
    expect(JSON.parse(host.textContent!)[field]).toBe(expected);
  }
  const before = renders;
  pane.metadata = { name: "Editor", description: "Changed description", updatedAt: "later" };
  await s.send();
  expect(renders).toBe(before);
  window.windowZoomed = true;
  await s.send();
  expect(JSON.parse(host.textContent!).windowZoomed).toBe(true);
  expect(renders).toBe(before + 1);
});

test("Terminal subscriptions distinguish loading from missing and reselect on navigation", async () => {
  const s = stream();
  function Terminal({ name = "worker-0", id = "%0", standalone = false }) {
    const pane = useSnapshotStore(useShallow((state) => standalone
      ? null : selectTerminalPane(state.snapshot, "alpha", name, id)));
    return <output>{pane === undefined ? "loading" : pane === null ? "missing" : pane.paneId}</output>;
  }
  await render(<Terminal />);
  expect(host.textContent).toBe("loading");
  await s.send();
  expect(host.textContent).toBe("%0");
  const panes = s.snapshot.sessions[0]!.windows[0]!.panes as Array<Record<string, unknown>>;
  const pane = panes.shift()!;
  await s.send();
  expect(host.textContent).toBe("missing");
  panes.push(pane);
  await s.send();
  expect(host.textContent).toBe("%0");
  await render(<Terminal name="worker-1" id="%1" />);
  expect(host.textContent).toBe("%1");
  await render(<Terminal standalone />);
  expect(host.textContent).toBe("missing");
  await act(async () => { useSnapshotStore.getState().setSnapshot(null); });
  expect(host.textContent).toBe("missing");
  await render(<Terminal />);
  expect(host.textContent).toBe("loading");
});
