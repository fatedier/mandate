import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChangesTab } from "../src/client/routes/window/changes/ChangesTab.js";
import type { FeatureChangedFileDto, FeatureChangesResponse } from "../src/shared/api/feature-changes.js";
import { fakePhoneWidth } from "./fake-phone-width.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Spelled out in full rather than partially: tests/ sits outside both
 *  typecheck gates, so a missing required field here is caught by nothing. */
function file(path: string, over: Partial<FeatureChangedFileDto> = {}): FeatureChangedFileDto {
  return {
    path,
    oldPath: null,
    status: "M",
    additions: 31,
    deletions: 12,
    binary: false,
    uncommitted: false,
    untracked: false,
    ...over
  };
}

const CHANGES: FeatureChangesResponse = {
  compare: "head",
  baseRef: "main",
  mergeBase: "abc1234",
  head: "def5678",
  files: [
    file("src/client/routes/window/chat/MobileChatSheet.tsx"),
    file("tests/mobile-chat-sheet.test.tsx", { status: "A", additions: 432, deletions: 0 })
  ],
  totalAdditions: 463,
  totalDeletions: 12
};

const PATCH = {
  path: "x",
  patch: "@@ -27,1 +27,1 @@\n-old line\n+new line\n",
  truncated: false,
  binary: false
};

const realFetch = globalThis.fetch;
function stubFetch() {
  (globalThis as { fetch: unknown }).fetch = async (input: RequestInfo | URL) => {
    // Real shapes (src/shared/api/routes.ts:31,90):
    //   list  /api/features/:id/changes
    //   patch /api/features/:id/changes/file?path=...
    // Match on the path segment, not on "file" anywhere in the URL — the
    // ?path= query carries file names and would match by accident.
    const url = String(input);
    const body = url.includes("/changes/file") ? PATCH : CHANGES;
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
}
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

/** Every test mounts *inside* its `try`, with the handle declared before it.
 *  bun runs all 224 test files in one process, so a mount that throws between
 *  `fakePhoneWidth()` and the `try` would skip the restore and leak a 390px
 *  `window.innerWidth` into every later file — where it surfaces as a failure
 *  with no visible connection to this one. */
type Mounted = Awaited<ReturnType<typeof mount>>;

async function mount(initialFile: string | null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<ChangesTab featureId="feat_1" initialFile={initialFile} />);
  });
  // the loader is deferred a tick on purpose (repo idiom); let it land
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const BACK = '[aria-label="Back to changed files"]';
const DIFF = '[aria-label="File diff"]';
const LIST = '[aria-label="Changed files"]';

const listRows = (host: HTMLElement) => host.querySelectorAll('[id^="change-"]');
const fileBar = (host: HTMLElement) => host.querySelector(BACK);

/** Presence as a boolean, never the node. `expect(node).toBeNull()` serialises
 *  the entire happy-dom element on failure — listener maps plus the whole
 *  parent chain, ~100MB — which stalls the runner instead of reporting. The
 *  selector already says which node was meant, so the node adds nothing. */
const has = (host: HTMLElement, selector: string) => host.querySelector(selector) !== null;

test("mobile with nothing selected shows the file list and no diff", async () => {
  stubFetch();
  const restore = fakePhoneWidth();
  let view: Mounted | null = null;
  try {
    view = await mount(null);
    expect(listRows(view.host).length).toBe(2);
    expect(has(view.host, BACK)).toBe(false);
    expect(has(view.host, DIFF)).toBe(false);
    // The list is what tells you how much is inside before you open it.
    expect(view.host.textContent).toContain("+432");
  } finally {
    view?.unmount();
    restore();
  }
});

test("mobile deep link opens the file view directly, with position", async () => {
  stubFetch();
  const restore = fakePhoneWidth();
  let view: Mounted | null = null;
  try {
    view = await mount("tests/mobile-chat-sheet.test.tsx");
    expect(has(view.host, BACK)).toBe(true);
    expect(view.host.textContent).toContain("2/2");
    expect(listRows(view.host).length).toBe(0);
  } finally {
    view?.unmount();
    restore();
  }
});

test("mobile next/prev step through files and stop at the ends", async () => {
  stubFetch();
  const restore = fakePhoneWidth();
  let view: Mounted | null = null;
  try {
    view = await mount("src/client/routes/window/chat/MobileChatSheet.tsx");
    const prev = view.host.querySelector('[aria-label="Previous file"]') as HTMLButtonElement;
    const next = view.host.querySelector('[aria-label="Next file"]') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    act(() => { next.click(); });
    expect(view.host.textContent).toContain("2/2");
    const next2 = view.host.querySelector('[aria-label="Next file"]') as HTMLButtonElement;
    expect(next2.disabled).toBe(true);
  } finally {
    view?.unmount();
    restore();
  }
});

test("mobile back returns to the list", async () => {
  stubFetch();
  const restore = fakePhoneWidth();
  let view: Mounted | null = null;
  try {
    view = await mount("src/client/routes/window/chat/MobileChatSheet.tsx");
    // Bound outside the closure: TypeScript cannot narrow `view` inside one (a
    // closure may run after a later reassignment), so `view.host` there is
    // possibly-null — and tests/ sits outside both tsconfigs, so nothing would
    // report it.
    const host = view.host;
    act(() => { (fileBar(host) as HTMLButtonElement).click(); });
    expect(listRows(view.host).length).toBe(2);
    expect(has(view.host, BACK)).toBe(false);
  } finally {
    view?.unmount();
    restore();
  }
});

test("mobile falls back to the list when the selected file is gone", async () => {
  stubFetch();
  const restore = fakePhoneWidth();
  // A dead deep link is the same state a refetch produces when it drops the
  // file you were reading. Desktop would show files[0] instead; on mobile that
  // would put a different file's diff under the header you just tapped.
  let view: Mounted | null = null;
  try {
    view = await mount("src/client/routes/window/chat/DeletedByRefetch.tsx");
    expect(has(view.host, BACK)).toBe(false);
    // The load-bearing one: without it this test cannot tell the mobile list
    // from the desktop sidebar, which also renders two `change-` rows and no
    // file bar. It is the absence of a diff that says the fallback was to
    // *nothing* rather than to files[0].
    expect(has(view.host, DIFF)).toBe(false);
    expect(listRows(view.host).length).toBe(2);
  } finally {
    view?.unmount();
    restore();
  }
});

/** The seam between the two halves of this feature. Task 1 gave DiffHunkView a
 *  unified mode whose long lines scroll instead of wrapping; Task 2 is the only
 *  thing that turns it on. Without this test, deleting `unified` from the
 *  <ChangedFileDetail> below leaves the whole suite green — verified by
 *  mutation, which is why the assertion exists.
 *
 *  The first assert is deliberately one the mutation does *not* break: split
 *  mode renders the same text. It proves the patch actually loaded, so a red
 *  `diff-line` assertion means "rendered split", not "rendered nothing". */
test("the mobile file view renders the diff unified, not split", async () => {
  stubFetch();
  const restore = fakePhoneWidth();
  let view: Mounted | null = null;
  try {
    view = await mount("src/client/routes/window/chat/MobileChatSheet.tsx");
    expect(view.host.textContent).toContain("new line");
    expect(view.host.querySelectorAll('[data-slot="diff-line"]').length).toBeGreaterThan(0);
    expect(has(view.host, "table")).toBe(false);
  } finally {
    view?.unmount();
    restore();
  }
});

test("desktop is untouched — sidebar renders and there is no file bar", async () => {
  stubFetch();
  let view: Mounted | null = null;
  try {
    view = await mount(null);   // no fakePhoneWidth: happy-dom is 1024px
    expect(has(view.host, LIST)).toBe(true);
    expect(view.host.querySelector(LIST)!.className).toContain("w-60");
    expect(has(view.host, BACK)).toBe(false);
    // desktop still falls back to the first file, so a diff is always showing
    expect(has(view.host, DIFF)).toBe(true);
    // Per-file counts are mobile-only. Scoped to the sidebar on purpose: the
    // detail header renders the same "+31 −12" for the open file, so an
    // unscoped assertion would pass no matter what the sidebar does. In the
    // 240px sidebar these counts cost 40-66px per row and collapse the
    // directory hint — the one thing telling two same-named files apart.
    expect(view.host.querySelector(LIST)!.textContent).not.toContain("+31");
  } finally {
    view?.unmount();
  }
});

/** The desktop mirror of the seam above, and it needs its own test for the same
 *  reason: `diff-hunk-view.test.tsx` passes `unified={false}` explicitly, so it
 *  pins the component, not the caller. Adding `unified` to the desktop
 *  <ChangedFileDetail> was verified to leave the whole suite green before this
 *  existed — the split view is the desktop's entire layout and nothing was
 *  holding it there.
 *
 *  Same isolation rule as the mobile one: assert 1 survives the mutation
 *  (unified mode renders the same text), so a red assert 2 means "rendered
 *  unified", not "rendered nothing". */
test("the desktop file view renders the diff split, not unified", async () => {
  stubFetch();
  let view: Mounted | null = null;
  try {
    view = await mount(null);   // no fakePhoneWidth: happy-dom is 1024px
    expect(view.host.textContent).toContain("new line");
    expect(has(view.host, "table")).toBe(true);
    expect(view.host.querySelectorAll('[data-slot="diff-line"]').length).toBe(0);
  } finally {
    view?.unmount();
  }
});
