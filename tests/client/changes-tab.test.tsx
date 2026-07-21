import { afterEach, describe, expect, test } from "bun:test";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  FeatureChangedFileDto,
  FeatureChangesFileResponse,
  FeatureChangesResponse,
  WorkItemDto
} from "@shared/api-contracts";
import { ChangesTab } from "@/routes/window/changes/ChangesTab";
import { useWorkItemsStore } from "@/store/work-items";
import { fakePhoneWidth } from "../fake-phone-width";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

/** Let in-flight promises resolve, zero-delay timers fire, and React flush the results. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function fileDto(path: string): FeatureChangedFileDto {
  return {
    path,
    oldPath: null,
    status: "M",
    additions: 1,
    deletions: 1,
    binary: false,
    uncommitted: false,
    untracked: false
  };
}

const LIST: FeatureChangesResponse = {
  compare: "head",
  baseRef: "HEAD",
  mergeBase: "abc123",
  head: "def456",
  files: [fileDto("src/a.ts"), fileDto("src/b.ts")],
  totalAdditions: 2,
  totalDeletions: 2
};

function patchFor(path: string): string {
  const token = path.endsWith("a.ts") ? "alpha-line" : "beta-line";
  return ["--- a/x", "+++ b/x", "@@ -1,1 +1,1 @@", `-old-${token}`, `+new-${token}`].join("\n");
}

function routedFetch(url: string): Response {
  if (url.includes("/changes/file")) {
    const path = new URL(url, "http://localhost").searchParams.get("path") ?? "";
    const body: FeatureChangesFileResponse = {
      path,
      patch: patchFor(path),
      truncated: false,
      binary: false
    };
    return Response.json(body);
  }
  return Response.json(LIST);
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe("ChangesTab master-detail", () => {
  test("lists files in a left pane and shows the first file's diff", async () => {
    await withFetch(routedFetch, async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settle();
      const aside = container!.querySelector("aside");
      expect(aside).not.toBeNull();
      expect(aside!.textContent).toContain("a.ts");
      expect(aside!.textContent).toContain("b.ts");
      expect(aside!.querySelector('[aria-current="true"]')?.textContent).toContain("a.ts");
      expect(container!.textContent).toContain("alpha-line");
      expect(container!.textContent).not.toContain("beta-line");
    });
  });

  test("clicking a file in the list switches the detail pane", async () => {
    await withFetch(routedFetch, async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settle();
      const item = Array.from(container!.querySelectorAll("aside button")).find((b) =>
        b.textContent?.includes("b.ts")
      ) as HTMLButtonElement | undefined;
      expect(item).toBeDefined();
      act(() => {
        item!.click();
      });
      await settle();
      expect(container!.textContent).toContain("beta-line");
      expect(container!.textContent).not.toContain("alpha-line");
      expect(item!.getAttribute("aria-current")).toBe("true");
    });
  });

  test("initialFile preselects that file in the list", async () => {
    await withFetch(routedFetch, async () => {
      render(<ChangesTab featureId="f1" initialFile="src/b.ts" />);
      await settle();
      expect(container!.textContent).toContain("beta-line");
      expect(container!.textContent).not.toContain("alpha-line");
    });
  });
});

describe("ChangesTab load errors", () => {
  test("non-JSON error body falls back to the status message", async () => {
    await withFetch(
      () => new Response("Internal Server Error", { status: 500 }),
      async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settle();
        expect(container!.textContent).toContain("request failed (500)");
        expect(container!.textContent).toContain("Retry");
      }
    );
  });

  test("JSON error body surfaces the server message", async () => {
    await withFetch(
      () =>
        new Response(JSON.stringify({ error: "git diff failed" }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }),
      async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settle();
        expect(container!.textContent).toContain("git diff failed");
      }
    );
  });
});

/**
 * Which comparison the tab asks for.
 *
 * Uncommitted is the default because the branch comparison needs a base ref and
 * a base ref goes stale: measured on a real store it showed 258 files where the
 * work was 16, 127 where it was 7, and errored outright on a branch orphaned by
 * a history rewrite. What is being changed right now cannot be wrong.
 */
describe("ChangesTab comparison mode", () => {
  function branchList(): FeatureChangesResponse {
    return { ...LIST, compare: "branch", baseRef: "main" };
  }

  test("asks for the uncommitted comparison on first load", async () => {
    const urls: string[] = [];
    await withFetch(
      (url) => {
        urls.push(url);
        return routedFetch(url);
      },
      async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settle();
        expect(urls[0]).toContain("compare=head");
        expect(urls[0]).not.toContain("compare=branch");
      }
    );
  });

  test("names no ref while showing uncommitted work", async () => {
    // Naming any ref here would be a claim about a base this view never
    // consulted — including "vs HEAD", which reads as a comparison against the
    // last commit rather than what it is.
    await withFetch(routedFetch, async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settle();
      expect(container!.textContent).toContain("2 files");
      expect(container!.textContent).not.toContain(" vs ");
    });
  });

  test("the phone layout carries the mode into the file patch too", async () => {
    // The narrow branch renders its own ChangedFileDetail, and happy-dom is
    // 1024px wide, so without this the mobile call site is never mounted.
    const restore = fakePhoneWidth();
    const fileUrls: string[] = [];
    try {
      await withFetch(
        (url) => {
          if (url.includes("/changes/file")) fileUrls.push(url);
          return routedFetch(url);
        },
        async () => {
          render(<ChangesTab featureId="f1" initialFile="src/a.ts" />);
          await settle();
          expect(fileUrls.length).toBeGreaterThan(0);
          expect(fileUrls.every((u) => u.includes("compare=head"))).toBe(true);
        }
      );
    } finally {
      restore();
    }
  });

  test("switching to the branch comparison refetches with that mode", async () => {
    const urls: string[] = [];
    await withFetch(
      (url) => {
        urls.push(url);
        if (url.includes("compare=branch") && !url.includes("/changes/file")) {
          return Response.json(branchList());
        }
        return routedFetch(url);
      },
      async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settle();

        const toggle = [...container!.querySelectorAll("button")].find(
          (b) => b.textContent?.includes("Since base")
        );
        expect(toggle).toBeTruthy();
        act(() => toggle!.click());
        await settle();

        expect(urls.some((u) => u.includes("compare=branch"))).toBe(true);
        expect(container!.textContent).toContain("vs main");
      }
    );
  });

  test("the file patch is fetched for the same comparison as the list", async () => {
    // The server gates every file read on membership in that mode's change set,
    // so a patch requested under the other mode is a 404 at best.
    const fileUrls: string[] = [];
    await withFetch(
      (url) => {
        if (url.includes("/changes/file")) fileUrls.push(url);
        if (url.includes("compare=branch") && !url.includes("/changes/file")) {
          return Response.json(branchList());
        }
        return routedFetch(url);
      },
      async () => {
        render(<ChangesTab featureId="f1" initialFile="src/a.ts" />);
        await settle();
        expect(fileUrls.every((u) => u.includes("compare=head"))).toBe(true);

        const toggle = [...container!.querySelectorAll("button")].find(
          (b) => b.textContent?.includes("Since base")
        );
        act(() => toggle!.click());
        await settle();
        expect(fileUrls.some((u) => u.includes("compare=branch"))).toBe(true);
      }
    );
  });

  test("the empty state says which question came back empty", async () => {
    await withFetch(
      (url) =>
        url.includes("/changes/file")
          ? routedFetch(url)
          : Response.json({ ...LIST, files: [], totalAdditions: 0, totalDeletions: 0 }),
      async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settle();
        expect(container!.textContent).toContain("Nothing uncommitted");
      }
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function click(selector: string): void {
  const button = container!.querySelector<HTMLButtonElement>(selector);
  expect(!!button).toBe(true);
  act(() => button!.click());
}

function chooseFile(path: string): void {
  if (container!.querySelector('[aria-label="Back to changed files"]')) {
    click('[aria-label="Back to changed files"]');
  }
  click(`[id="change-${path}"]`);
}

function chooseComparison(label: string): void {
  const button = [...container!.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(!!button).toBe(true);
  act(() => button!.click());
}

function patchResponse(path: string, revision: string): Response {
  return Response.json({ path, patch: `@@ -1 +1 @@\n-old\n+${revision}-${path}\n`, truncated: false, binary: false });
}

const detailText = () => container!.querySelector('[aria-label="File diff"]')?.textContent ?? "";

describe("ChangesTab diff lifetime", () => {
  for (const pending of [false, true]) {
    test(`reuses ${pending ? "in-flight" : "completed"} patches when returning to a file under StrictMode`, async () => {
      const held = deferred<Response>();
      const paths: string[] = [];
      await withFetch((url) => {
        if (!url.includes("/changes/file")) return Response.json(LIST);
        const path = new URL(url, "http://localhost").searchParams.get("path")!;
        paths.push(path);
        return pending && path === "src/a.ts" ? held.promise : routedFetch(url);
      }, async () => {
        render(<StrictMode><ChangesTab featureId="f1" initialFile={null} /></StrictMode>);
        await settle();
        chooseFile("src/b.ts");
        await settle();
        expect(detailText()).toContain("beta-line");
        chooseFile("src/a.ts");
        if (!pending) expect(detailText()).toContain("alpha-line");
        await settle();
        expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
        if (pending) {
          await act(async () => { held.resolve(patchResponse("src/a.ts", "resolved")); });
          expect(detailText()).toContain("resolved-src/a.ts");
        }
        expect(detailText()).not.toContain("beta-line");
      });
    });
  }

  for (const mobile of [false, true]) {
    test(`refresh invalidates all patches at the same HEAD on ${mobile ? "mobile" : "desktop"}`, async () => {
      const restore = mobile ? fakePhoneWidth() : () => {};
      let revision = "before";
      let listRequests = 0;
      const patchRequests: string[] = [];
      try {
        await withFetch((url) => {
          if (!url.includes("/changes/file")) { listRequests++; return Response.json(LIST); }
          const path = new URL(url, "http://localhost").searchParams.get("path")!;
          patchRequests.push(`${revision}:${path}`);
          return patchResponse(path, revision);
        }, async () => {
          render(<ChangesTab featureId="f1" initialFile="src/a.ts" />);
          await settle();
          chooseFile("src/b.ts");
          await settle();
          chooseFile("src/a.ts");
          await settle();
          revision = "after";
          click('[aria-label="Refresh changes"]');
          expect(container!.querySelector<HTMLButtonElement>('[aria-label="Refreshing changes"]')?.disabled).toBe(true);
          await settle();
          expect(detailText()).toContain("after-src/a.ts");
          expect(detailText()).not.toContain("before");
          chooseFile("src/b.ts");
          await settle();
          expect(detailText()).toContain("after-src/b.ts");
          expect(patchRequests).toEqual(["before:src/a.ts", "before:src/b.ts", "after:src/a.ts", "after:src/b.ts"]);
          expect(listRequests).toBe(2);
        });
      } finally { restore(); }
    });
  }

  test("work-item transitions refresh patches but unrelated metadata does not", async () => {
    const originalItems = useWorkItemsStore.getState().items;
    const item: WorkItemDto = {
      id: "changes-item", featureId: "f1", projectId: "p1", title: "Changes", summary: "",
      phase: "working", phaseDetail: null, needsUser: null, canvasId: null,
      summaryUpdatedAt: null, summaryUpdatedBy: null, lastActivityAt: "2026-09-15T00:00:00Z",
      createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z"
    };
    useWorkItemsStore.setState({ items: new Map([[item.id, item]]) });
    let revision = "working";
    let listRequests = 0;
    try {
      await withFetch((url) => {
        if (!url.includes("/changes/file")) { listRequests++; return Response.json(LIST); }
        return patchResponse("src/a.ts", revision);
      }, async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settle();
        act(() => useWorkItemsStore.getState().upsert({ ...item, title: "Renamed", updatedAt: "2026-09-15T00:00:01Z" }));
        await settle();
        expect(listRequests).toBe(1);
        revision = "review";
        act(() => useWorkItemsStore.getState().upsert({ ...item, needsUser: "review", updatedAt: "2026-09-15T00:00:02Z" }));
        await settle();
        expect(listRequests).toBe(2);
        expect(detailText()).toContain("review-src/a.ts");
        revision = "done";
        act(() => useWorkItemsStore.getState().upsert({ ...item, phase: "done", updatedAt: "2026-09-15T00:00:03Z" }));
        await settle();
        expect(listRequests).toBe(3);
        expect(detailText()).toContain("done-src/a.ts");
      });
    } finally {
      act(() => useWorkItemsStore.setState({ items: originalItems }));
    }
  });

  test("refresh aborts old patches and late bodies cannot enter the new cache", async () => {
    const body = deferred<unknown>();
    let oldSignal: AbortSignal | null | undefined;
    let patchRequests = 0;
    await withFetch((url, init) => {
      if (!url.includes("/changes/file")) return Response.json(LIST);
      patchRequests++;
      if (patchRequests === 1) {
        oldSignal = init?.signal;
        return { ok: true, json: () => body.promise } as Response;
      }
      const path = new URL(url, "http://localhost").searchParams.get("path")!;
      return patchResponse(path, "current");
    }, async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settle();
      expect(oldSignal?.aborted).toBe(false);
      click('[aria-label="Refresh changes"]');
      await settle();
      expect(oldSignal?.aborted).toBe(true);
      expect(detailText()).toContain("current-src/a.ts");
      await act(async () => { body.resolve({ patch: "@@ -1 +1 @@\n+stale\n", truncated: true }); });
      chooseFile("src/b.ts");
      await settle();
      chooseFile("src/a.ts");
      expect(detailText()).toContain("current-src/a.ts");
      expect(detailText()).not.toContain("stale");
      expect(detailText()).not.toContain("truncated");
      expect(patchRequests).toBe(3);
    });
  });

  for (const lateFailure of [false, true]) {
    test(`comparison changes ignore an obsolete list ${lateFailure ? "failure" : "success"}`, async () => {
      const branch = deferred<Response>();
      let branchSignal: AbortSignal | null | undefined;
      const patchModes: string[] = [];
      await withFetch((url, init) => {
        const mode = new URL(url, "http://localhost").searchParams.get("compare")!;
        if (url.includes("/changes/file")) {
          patchModes.push(mode);
          return patchResponse("src/a.ts", mode);
        }
        if (mode === "branch") { branchSignal = init?.signal; return branch.promise; }
        return Response.json(LIST);
      }, async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settle();
        chooseComparison("Since base");
        await settle();
        expect(branchSignal?.aborted).toBe(false);
        chooseComparison("Uncommitted");
        expect(branchSignal?.aborted).toBe(true);
        await settle();
        await act(async () => {
          if (lateFailure) branch.reject(new Error("obsolete error"));
          else branch.resolve(Response.json({ ...LIST, compare: "branch", baseRef: "obsolete-base" }));
        });
        expect(detailText()).toContain("head-src/a.ts");
        expect(container!.textContent).not.toContain("obsolete");
        expect(patchModes).toEqual(["head", "head"]);
      });
    });
  }

  test("changing Worker rejects the previous Worker's delayed list", async () => {
    const first = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    const patchUrls: string[] = [];
    await withFetch((url, init) => {
      if (url.includes("/changes/file")) { patchUrls.push(url); return patchResponse("src/a.ts", "second-worker"); }
      if (url.includes("/features/f1/")) { signal = init?.signal; return first.promise; }
      return Response.json(LIST);
    }, async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settle();
      act(() => root!.render(<ChangesTab featureId="f2" initialFile={null} />));
      expect(signal?.aborted).toBe(true);
      await settle();
      await act(async () => { first.resolve(Response.json({ ...LIST, files: [fileDto("obsolete.ts")] })); });
      expect(detailText()).toContain("second-worker");
      expect(container!.textContent).not.toContain("obsolete.ts");
      expect(patchUrls.length).toBe(1);
      expect(patchUrls[0]).toContain("/features/f2/");
    });
  });

  for (const holdPatch of [false, true]) {
    test(`leaving the page aborts the pending ${holdPatch ? "patch" : "list"} and reopening starts fresh`, async () => {
      const held = deferred<Response>();
      let signal: AbortSignal | null | undefined;
      let reopened = false;
      await withFetch((url, init) => {
        if (!reopened && url.includes("/changes/file") === holdPatch) {
          signal = init?.signal;
          return held.promise;
        }
        return routedFetch(url);
      }, async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settle();
        expect(signal?.aborted).toBe(false);
        act(() => root!.render(null));
        expect(signal?.aborted).toBe(true);
        reopened = true;
        act(() => root!.render(<ChangesTab featureId="f1" initialFile={null} />));
        await settle();
        await act(async () => { held.resolve(holdPatch ? patchResponse("src/a.ts", "obsolete") : Response.json({ ...LIST, files: [] })); });
        expect(detailText()).toContain("alpha-line");
        expect(container!.textContent).not.toContain("obsolete");
      });
    });
  }

  test("failed patches are retryable and binary files never fetch a patch", async () => {
    let attempts = 0;
    await withFetch((url) => {
      if (!url.includes("/changes/file")) return Response.json({ ...LIST, files: [LIST.files[0], { ...LIST.files[1], binary: true }] });
      attempts++;
      return attempts === 1 ? new Response(null, { status: 503 }) : routedFetch(url);
    }, async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settle();
      expect(detailText()).toContain("patch fetch failed (503)");
      chooseFile("src/b.ts");
      await settle();
      expect(detailText()).toContain("Binary file");
      expect(attempts).toBe(1);
      chooseFile("src/a.ts");
      await settle();
      expect(detailText()).toContain("alpha-line");
      expect(detailText()).not.toContain("failed");
      expect(attempts).toBe(2);
    });
  });
});

for (const automatic of [false, true]) {
  test(`a slow ${automatic ? "work-item" : "manual"} refresh keeps displayed patches usable until replacement`, async () => {
    const originalItems = useWorkItemsStore.getState().items;
    const item: WorkItemDto = {
      id: "refresh-item", featureId: "f1", projectId: "p1", title: "Changes", summary: "",
      phase: "working", phaseDetail: null, needsUser: null, canvasId: null,
      summaryUpdatedAt: null, summaryUpdatedBy: null, lastActivityAt: "2026-09-15T00:00:00Z",
      createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z"
    };
    useWorkItemsStore.setState({ items: new Map([[item.id, item]]) });
    const refresh = deferred<Response>();
    const nextList = { ...LIST, files: [...LIST.files, fileDto("src/c.ts")] };
    let listRequests = 0;
    const patches: string[] = [];
    let revision = "before";
    try {
      await withFetch((url) => {
        if (!url.includes("/changes/file")) return ++listRequests === 1 ? Response.json(nextList) : refresh.promise;
        const path = new URL(url, "http://localhost").searchParams.get("path")!;
        patches.push(path);
        return patchResponse(path, revision);
      }, async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settle();
        chooseFile("src/b.ts");
        await settle();
        if (automatic) act(() => useWorkItemsStore.getState().upsert({ ...item, phase: "done" }));
        else click('[aria-label="Refresh changes"]');
        await settle();
        expect(listRequests).toBe(2);
        chooseFile("src/a.ts");
        expect(detailText()).toContain("before-src/a.ts");
        chooseFile("src/b.ts");
        expect(detailText()).toContain("before-src/b.ts");
        expect(patches).toEqual(["src/a.ts", "src/b.ts"]);
        chooseFile("src/c.ts");
        await settle();
        expect(detailText()).toContain("before-src/c.ts");
        expect(patches).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
        revision = "after";
        await act(async () => { refresh.resolve(Response.json(nextList)); });
        await settle();
        expect(detailText()).toContain("after-src/c.ts");
        expect(patches).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/c.ts"]);
      });
    } finally {
      act(() => useWorkItemsStore.setState({ items: originalItems }));
    }
  });
}
