import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { ChangesSummaryLine } from "@/routes/window/ChangesSummaryLine";
import { resetChangesSummaryCache } from "@/routes/window/changes/useChangesSummary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;
let calls: string[] = [];

function stubChanges(body: unknown, status = 200) {
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

beforeEach(() => { calls = []; resetChangesSummaryCache(); });
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

async function render(featureId: string, stamp = "working:") {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter initialEntries={["/projects/p/features/f"]}>
        <ChangesSummaryLine featureId={featureId} workItemStamp={stamp} />
      </MemoryRouter>
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  return host!;
}

const RESPONSE = {
  compare: "head", baseRef: "HEAD", mergeBase: "abc", head: "def",
  files: [{ path: "a.go" }, { path: "b.go" }, { path: "c.go" }, { path: "d.go" }, { path: "e.go" }, { path: "f.go" }],
  totalAdditions: 412, totalDeletions: 689
};

test("renders +A −D · N files · uncommitted from the head comparison", async () => {
  stubChanges(RESPONSE);
  const el = await render("f1");
  const line = el.querySelector('[data-slot="changes-summary"]');
  expect(line === null).toBe(false);
  expect(line!.textContent).toBe("+412 −689 · 6 files · uncommitted");
  expect(calls.length).toBe(1);
  expect(calls[0]).toContain("compare=head");
});

test("one file is singular; zero files renders nothing", async () => {
  stubChanges({ ...RESPONSE, files: [{ path: "a.go" }], totalAdditions: 1, totalDeletions: 0 });
  let el = await render("f2");
  expect(el.querySelector('[data-slot="changes-summary"]')?.textContent).toBe("+1 −0 · 1 file · uncommitted");
  expect(calls.length).toBe(1);
  act(() => root?.unmount());
  host?.remove();
  stubChanges({ ...RESPONSE, files: [], totalAdditions: 0, totalDeletions: 0 });
  el = await render("f3");
  // Loaded and chose to render nothing — not "never loaded".
  expect(calls.length).toBe(2);
  expect(el.querySelector('[data-slot="changes-summary"]') === null).toBe(true);
});

test("a failed request renders nothing and does not throw", async () => {
  stubChanges({ error: "not a git repo" }, 500);
  const el = await render("f4");
  expect(calls.length).toBe(1);
  expect(el.querySelector('[data-slot="changes-summary"]') === null).toBe(true);
});

test("a reconnect refetches even when the mount was served from the cache", async () => {
  stubChanges(RESPONSE);
  await render("f6");
  act(() => root?.unmount());
  host?.remove();
  const el = await render("f6");
  expect(calls.length).toBe(1);
  await act(async () => {
    // CustomEvent, not Event: the harness maps CustomEvent to happy-dom's
    // class and happy-dom rejects bun's native Event. Matches the app, which
    // dispatches `new CustomEvent("mandate:sse-open")`.
    window.dispatchEvent(new CustomEvent("mandate:sse-open"));
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(calls.length).toBe(2);
  expect(el.querySelector('[data-slot="changes-summary"]')?.textContent).toBe("+412 −689 · 6 files · uncommitted");
});

test("the same feature and stamp is served from the cache without a second request", async () => {
  stubChanges(RESPONSE);
  await render("f5");
  act(() => root?.unmount());
  host?.remove();
  const el = await render("f5");
  expect(el.querySelector('[data-slot="changes-summary"]')?.textContent).toBe("+412 −689 · 6 files · uncommitted");
  expect(calls.length).toBe(1);
});
