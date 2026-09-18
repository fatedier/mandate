import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { TmuxLayoutBoard } from "@/routes/window/TmuxLayoutBoard";
import type { SnapshotPane, SnapshotWindow } from "@/lib/snapshot-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

// Two side-by-side panes; the layout string is the one parseTmuxLayout's own
// test parses (tests/client-tmux.test.ts). Leaf ids 1 and 2 map to %1 and %2.
const WINDOW: SnapshotWindow = {
  windowId: "@1",
  windowName: "w",
  windowLayout: "abcd,80x24,0,0{40x24,0,0,1,40x24,40,0,2}",
  panes: [
    {
      paneId: "%1",
      paneIndex: 1,
      currentCommand: "zsh",
      changedAt: new Date().toISOString(),
      preview: Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"),
      metadata: { name: "Untracked file forensics", description: "", updatedAt: "" }
    },
    { paneId: "%2", paneIndex: 2, currentCommand: "codex", preview: "" }
  ]
};

function render(window: SnapshotWindow = WINDOW): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <TmuxLayoutBoard window={window} paneHref={(p) => `/t/${p.paneId}`} />
      </MemoryRouter>
    );
  });
  return host;
}

/** Same layout, each pane overridden field-by-field. */
function withPanes(first: Partial<SnapshotPane>, second: Partial<SnapshotPane>): SnapshotWindow {
  return { ...WINDOW, panes: [{ ...WINDOW.panes![0]!, ...first }, { ...WINDOW.panes![1]!, ...second }] };
}

test("an empty preview keeps its placeholder sentence, faint; a whitespace-only name counts as no name", () => {
  const el = render(withPanes(
    { preview: "", metadata: { name: "   ", description: "", updatedAt: "" } },
    { preview: "$ codex\nready" }
  ));
  const p = el.querySelectorAll('[data-slot="pane-panel"]')[0]!;
  const preview = p.querySelector('[data-slot="pane-preview"]')!;
  expect(preview.textContent).toBe("No captured output yet.");
  expect(preview.className.split(/\s+/)).toContain("text-faint");
  // The pane with output shows it and is not faint.
  const q = el.querySelectorAll('[data-slot="pane-panel"]')[1]!;
  expect(q.querySelector('[data-slot="pane-preview"]')!.textContent).toBe("$ codex\nready");
  expect(q.querySelector('[data-slot="pane-preview"]')!.className.split(/\s+/)).not.toContain("text-faint");
  expect(p.querySelector('[data-slot="pane-name"]')!.textContent).toBe("zsh");
  expect(p.querySelector('[data-slot="pane-name"]')!.className.split(/\s+/)).toContain("font-mono");
  expect(p.querySelector('[data-slot="pane-command"]') === null).toBe(true);
});

test("only a pane waiting on the user tints its panel border; the dot carries every other status", () => {
  const el = render(withPanes({ analysis: { status: "waiting_user" } }, { analysis: { status: "working" } }));
  const panels = el.querySelectorAll('[data-slot="pane-panel"]');
  expect(panels[0]!.className.split(/\s+/)).toContain("border-status-input/40");
  expect(panels[1]!.className.split(/\s+/)).not.toContain("border-status-input/40");
  expect(panels[1]!.querySelector('[data-slot="pane-dot"]') === null).toBe(false);
});

test("the board root is named and each pane is a panel with a header line and a clipped mono preview", () => {
  const el = render();
  expect(el.querySelector('[data-slot="pane-board"]') === null).toBe(false);
  const panels = Array.from(el.querySelectorAll('[data-slot="pane-panel"]'));
  expect(panels.length).toBe(2);
  const p = panels[0]!;
  for (const t of ["rounded-lg", "border-border-soft", "bg-panel"]) expect(p.className.split(/\s+/)).toContain(t);
  expect(p.className.split(/\s+/)).not.toContain("bg-card");
  expect(p.querySelector('[data-slot="pane-index"]')!.textContent).toBe("[1]");
  expect(p.querySelector('[data-slot="pane-name"]')!.textContent).toBe("Untracked file forensics");
  expect(p.querySelector('[data-slot="pane-name"]')!.className.split(/\s+/)).not.toContain("font-mono");
  expect(p.querySelector('[data-slot="pane-command"]')!.textContent).toBe("zsh");
  expect(p.querySelector('[data-slot="pane-menu"]')!.className.split(/\s+/)).toContain("size-7");
  const preview = p.querySelector('[data-slot="pane-preview"]')!;
  for (const t of ["font-mono", "whitespace-pre", "overflow-hidden", "bg-code-bg"]) expect(preview.className.split(/\s+/)).toContain(t);
  expect(preview.className.split(/\s+/)).not.toContain("whitespace-pre-wrap");
  const q = panels[1]!;
  expect(q.querySelector('[data-slot="pane-name"]')!.textContent).toBe("codex");
  expect(q.querySelector('[data-slot="pane-name"]')!.className.split(/\s+/)).toContain("font-mono");
  expect(q.querySelector('[data-slot="pane-command"]') === null).toBe(true);
});

test("the header line looks through a node/npm/env wrapper to the real foreground process", () => {
  // `currentCommand` is what tmux reports — the wrapper. The display command
  // (getPaneDisplayCommand) reads the foreground process behind it.
  const el = render(withPanes(
    // Named pane: the sub-label is the display command, not the raw wrapper.
    { currentCommand: "node", foregroundProcesses: [{ command: "node /opt/homebrew/bin/codex" }] },
    // Unnamed pane: the name IS the display command.
    { currentCommand: "node", foregroundProcesses: [{ command: "node /opt/homebrew/bin/codex" }] }
  ));
  const [named, unnamed] = Array.from(el.querySelectorAll('[data-slot="pane-panel"]'));
  expect(named!.querySelector('[data-slot="pane-name"]')!.textContent).toBe("Untracked file forensics");
  expect(named!.querySelector('[data-slot="pane-command"]')!.textContent).toBe("codex");
  expect(unnamed!.querySelector('[data-slot="pane-name"]')!.textContent).toBe("codex");
  expect(unnamed!.querySelector('[data-slot="pane-command"]') === null).toBe(true);
});
