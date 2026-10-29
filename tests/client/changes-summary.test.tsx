import { beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { ChangesSummaryLine } from "@/routes/window/ChangesSummaryLine";
import { resetChangesSummaryCache } from "@/routes/window/changes/useChangesSummary";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle, type Mounted } from "../helpers/mount.js";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { useWorkItemsStore } from "@/store/work-items";
import type { FeaturePlanDto } from "@shared/api-contracts";
import type { WorkItemDto } from "@shared/api/work-items";
import { stub } from "../helpers/typed.js";

let view: Mounted | null = null;
let calls: string[] = [];

function stubChanges(body: unknown, status = 200) {
  mockFetch(({ url }) => {
    calls.push(url);
    return jsonResponse(body, status);
  });
}

beforeEach(() => {
  calls = [];
  resetChangesSummaryCache();
  useFeaturePlansStore.setState({ plans: new Map() });
  useWorkItemsStore.setState({ items: new Map() });
});

async function render(featureId: string) {
  view = await mountAsync(
    <ChangesSummaryLine featureId={featureId} />,
    { path: "/projects/p/features/f" }
  );
  await settle();
  return view.host;
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
  view!.unmount();
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
  view!.unmount();
  const el = await render("f6");
  expect(calls.length).toBe(1);
  expect(el.querySelector('[data-slot="changes-summary"]')?.textContent).toBe("+412 −689 · 6 files · uncommitted");
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

test("the line refetches when the worker moves its plan on, as the Changes tab does; the work item's own changes do not", async () => {
  stubChanges(RESPONSE);
  useFeaturePlansStore.setState({ plans: new Map([["f8", stub<FeaturePlanDto>({ featureId: "f8", updatedAt: "2026-10-04T10:00:00.000Z" })]]) });
  await render("f8");
  expect(calls.length).toBe(1);
  await act(async () => {
    useFeaturePlansStore.setState({ plans: new Map([["f8", stub<FeaturePlanDto>({ featureId: "f8", updatedAt: "2026-10-04T10:05:00.000Z" })]]) });
  });
  await settle();
  expect(calls.length).toBe(2);
  await act(async () => {
    useWorkItemsStore.setState({ items: new Map([["wi8", stub<WorkItemDto>({ id: "wi8", featureId: "f8" })]]) });
  });
  await settle();
  expect(calls.length).toBe(2);
});
