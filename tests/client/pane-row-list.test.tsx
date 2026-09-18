import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { PaneRowList, RECENT_OUTPUT_MS, paneChangedAtFromSnapshot, paneRowsFromWindow, shortenHome, type PaneRowData } from "@/routes/sessions/PaneRowList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null; let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

const PANES: PaneRowData[] = [
  { paneId: "%28", index: 1, name: "Untracked file forensics", command: "zsh", path: "/Users/fate/local/go_projects/src/github.com/fatedier/frp", recentOutput: true },
  { paneId: "%29", index: 2, name: null, command: "codex", path: "/Users/fate/x", recentOutput: false }
];

function render(props: Partial<React.ComponentProps<typeof PaneRowList>> = {}) {
  host = document.createElement("div"); document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<MemoryRouter><PaneRowList panes={PANES} hrefFor={(p) => `/t/${encodeURIComponent(p.paneId)}`} {...props} /></MemoryRouter>);
  });
  return host!;
}

test("shortenHome replaces the home prefix only", () => {
  expect(shortenHome("/Users/fate/local/x")).toBe("~/local/x");
  expect(shortenHome("/home/fate")).toBe("~");
  expect(shortenHome("/opt/app")).toBe("/opt/app");
});

test("each pane is a 56px row: index column, name or mono command, mono command · ~path, dot, link", () => {
  const el = render();
  const rows = Array.from(el.querySelectorAll('[data-slot="pane-row"]'));
  expect(rows.length).toBe(2);
  const first = rows[0]!;
  expect(first.querySelector("a")!.getAttribute("href")).toBe("/t/%2528");
  expect(first.querySelector("a")!.className.split(/\s+/)).toContain("min-h-14");
  expect(first.querySelector('[data-slot="pane-index"]')!.textContent).toBe("[1]");
  const name = first.querySelector('[data-slot="pane-name"]')!;
  expect(name.textContent).toBe("Untracked file forensics");
  expect(name.className.split(/\s+/)).not.toContain("font-mono");
  const meta = first.querySelector('[data-slot="pane-meta"]')!;
  expect(meta.textContent).toBe("zsh · ~/local/go_projects/src/github.com/fatedier/frp");
  expect(meta.className.split(/\s+/)).toContain("font-mono");
  expect(first.querySelector('[data-slot="pane-dot"]')!.className.split(/\s+/)).toContain("bg-live");
  // aria-label is inert on a bare span; role="img" is what makes the dot speak.
  expect(first.querySelector('[data-slot="pane-dot"]')!.getAttribute("role")).toBe("img");
  const second = rows[1]!;
  const secondName = second.querySelector('[data-slot="pane-name"]')!;
  expect(secondName.textContent).toBe("codex");
  expect(secondName.className.split(/\s+/)).toContain("font-mono");
  expect(second.querySelector('[data-slot="pane-dot"]')!.className.split(/\s+/)).toContain("bg-faint");
});

test("the current pane is highlighted with --sel and aria-current", () => {
  const el = render({ currentPaneId: "%29" });
  const rows = Array.from(el.querySelectorAll('[data-slot="pane-row"]'));
  expect(rows[0]!.getAttribute("data-current")).toBe("false");
  expect(rows[1]!.getAttribute("data-current")).toBe("true");
  expect(rows[1]!.querySelector("a")!.getAttribute("aria-current")).toBe("true");
  expect(rows[1]!.querySelector("a")!.className.split(/\s+/)).toContain("bg-sel");
});

test("dense rows print the prefix before the name and a relative time when `at` is set", () => {
  const el = render({ dense: true, panes: [{ ...PANES[1]!, prefix: "frp_issue_5460", at: "2026-09-17T09:58:00Z" }] });
  const row = el.querySelector('[data-slot="pane-row"]')!;
  expect(row.querySelector('[data-slot="pane-prefix"]')!.textContent).toContain("frp_issue_5460");
  expect(row.querySelector('[data-slot="pane-meta"]') === null).toBe(true);
  expect(row.querySelector("a")!.className.split(/\s+/)).toContain("min-h-11");
  // RelativeTime renders bare text, so the contract is the wrapper slot with non-empty text.
  const at = row.querySelector('[data-slot="pane-at"]');
  expect(at === null).toBe(false);
  expect((at!.textContent ?? "").trim().length > 0).toBe(true);
});

test("paneChangedAtFromSnapshot reads one session's panes and ignores the others", () => {
  const snap = { sessions: [
    { sessionName: "a", windows: [{ panes: [{ paneId: "%1", changedAt: "2026-09-17T09:00:00Z" }] }] },
    { sessionName: "b", windows: [{ panes: [{ paneId: "%2", changedAt: "2026-09-17T09:30:00Z" }] }] }
  ] } as unknown as import("@/lib/snapshot-types").TypedSnapshot;
  expect(paneChangedAtFromSnapshot(snap, "b")).toEqual({ "%2": "2026-09-17T09:30:00Z" });
  expect(paneChangedAtFromSnapshot(null, "b")).toEqual({});
});

test("paneRowsFromWindow maps a WindowDetailDto and marks recent output from changedAt within 5 minutes", () => {
  const now = Date.parse("2026-09-17T10:00:00Z");
  const rows = paneRowsFromWindow({
    sessionName: "s", name: "main", windowId: "@9", index: 2, active: true, windowLayout: "",
    panes: [
      { paneId: "%1", index: 1, active: true, currentCommand: "zsh", currentPath: "/home/fate/a", preview: "", metadata: { name: "N", description: "", updatedAt: "" } },
      { paneId: "%2", index: 2, active: false, currentCommand: "codex", currentPath: "/home/fate/b", preview: "" }
    ]
  }, { "%1": "2026-09-17T09:58:00Z", "%2": "2026-09-17T09:40:00Z" }, now);
  expect(rows.map((r) => [r.paneId, r.name, r.command, r.recentOutput])).toEqual([["%1", "N", "zsh", true], ["%2", null, "codex", false]]);
});

test("recent output is inclusive at exactly RECENT_OUTPUT_MS and false one millisecond older", () => {
  const now = Date.parse("2026-09-17T10:00:00Z");
  const detail = {
    sessionName: "s", name: "main", windowId: "@9", index: 2, active: true, windowLayout: "",
    panes: [
      { paneId: "%1", index: 1, active: true, currentCommand: "zsh", currentPath: "/a", preview: "" },
      { paneId: "%2", index: 2, active: false, currentCommand: "zsh", currentPath: "/b", preview: "" }
    ]
  };
  const rows = paneRowsFromWindow(detail, {
    "%1": new Date(now - RECENT_OUTPUT_MS).toISOString(),
    "%2": new Date(now - RECENT_OUTPUT_MS - 1).toISOString()
  }, now);
  expect(rows.map((r) => [r.paneId, r.recentOutput])).toEqual([["%1", true], ["%2", false]]);
});

test("dense rows with onDismiss carry a × that calls back and does not navigate; default rows never do", () => {
  let dismissed: string | null = null;
  const el = render({ dense: true, panes: [PANES[0]!], onDismiss: (p) => { dismissed = p.paneId; } });
  const btn = el.querySelector<HTMLButtonElement>('[data-slot="pane-dismiss"]')!;
  expect(btn === null).toBe(false);
  expect(btn.getAttribute("aria-label")).toBe("Remove from Recent");
  expect(btn.className.split(/\s+/)).toContain("before:-inset-2");
  // React handles clicks at the root container, so a listener on the <a>
  // itself would run BEFORE preventDefault; listen above the root instead.
  let navigated = false;
  document.addEventListener("click", (e) => { if (!e.defaultPrevented) navigated = true; }, { once: true });
  act(() => { btn.click(); });
  expect<string | null>(dismissed).toBe("%28");
  expect(navigated).toBe(false);
  const plain = render({ panes: [PANES[0]!], onDismiss: () => {} });
  expect(plain.querySelector('[data-slot="pane-dismiss"]') === null).toBe(true);
});
