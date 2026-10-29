import { describe, expect, test } from "bun:test";
import { act, StrictMode, type ReactNode } from "react";
import type {
  FeatureChangedFileDto,
  FeatureChangesFileResponse,
  FeatureChangesResponse,
  WorkItemDto
} from "@shared/api-contracts";
import { ChangesTab } from "@/routes/window/changes/ChangesTab";
import { useWorkItemsStore } from "@/store/work-items";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { emptyPlan } from "@shared/api/plans";
import { fakePhoneWidth } from "../fake-phone-width";
import { mockFetch, withFetch } from "../helpers/fetch.js";
import { mount, mountAsync, type Mounted, settle, settleRounds } from "../helpers/mount.js";

let view: Mounted | null = null;
let container: HTMLElement | null = null;

function render(node: ReactNode): void {
  view = mount(node);
  container = view.host;
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

describe("ChangesTab master-detail", () => {
  test("lists files in a left pane and shows the first file's diff", async () => {
    await withFetch(({ url }) => routedFetch(url), async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settleRounds();
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
    await withFetch(({ url }) => routedFetch(url), async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settleRounds();
      const item = Array.from(container!.querySelectorAll("aside button")).find((b) =>
        b.textContent?.includes("b.ts")
      ) as HTMLButtonElement | undefined;
      expect(item).toBeDefined();
      act(() => {
        item!.click();
      });
      await settleRounds();
      expect(container!.textContent).toContain("beta-line");
      expect(container!.textContent).not.toContain("alpha-line");
      expect(item!.getAttribute("aria-current")).toBe("true");
    });
  });

  test("initialFile preselects that file in the list", async () => {
    await withFetch(({ url }) => routedFetch(url), async () => {
      render(<ChangesTab featureId="f1" initialFile="src/b.ts" />);
      await settleRounds();
      expect(container!.textContent).toContain("beta-line");
      expect(container!.textContent).not.toContain("alpha-line");
    });
  });
});

describe("ChangesTab load errors", () => {
  test("a missing worktree says so in words and keeps the server's sentence, with Retry", async () => {
    await withFetch(
      () => Response.json({ error: "The worktree folder /w/feat is missing. Archive the worker from its ⋯ menu if it's finished.", code: "worktree_missing" }, { status: 409 }),
      async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settleRounds();
        const alert = container!.querySelector('[data-slot="inline-error"]')!;
        expect(alert.textContent).toContain("This worker's worktree folder is missing, so there are no changes to show.");
        expect(alert.textContent).toContain("/w/feat");
        expect(alert.querySelector("button")!.textContent).toBe("Retry");
        expect(container!.querySelector(".text-destructive:not(svg)") === null).toBe(true);
      }
    );
  });

  test("any other failure is \"Couldn't load changes.\" with the server's reason below", async () => {
    await withFetch(
      () => Response.json({ error: "git diff failed" }, { status: 500 }),
      async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settleRounds();
        const alert = container!.querySelector('[data-slot="inline-error"]')!;
        expect(alert.querySelector("span")!.textContent).toBe("Couldn't load changes.");
        expect(alert.querySelector("p")!.textContent).toBe("git diff failed");
      }
    );
  });

  test("non-JSON error body falls back to the status message", async () => {
    await withFetch(
      () => new Response("Internal Server Error", { status: 500 }),
      async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settleRounds();
        expect(container!.textContent).toContain("request failed (500)");
        expect(container!.textContent).toContain("Retry");
      }
    );
  });

});

/**
 * Which comparison the tab asks for.
 *
 * Uncommitted is the default because the branch comparison needs a base ref and
 * a base ref goes stale: it then lists far more files than the work touched,
 * and errors outright on a branch orphaned by a history rewrite. What is being
 * changed right now cannot be wrong.
 */
describe("ChangesTab comparison mode", () => {
  function branchList(): FeatureChangesResponse {
    return { ...LIST, compare: "branch", baseRef: "main" };
  }

  test("asks for the uncommitted comparison on first load", async () => {
    const urls: string[] = [];
    await withFetch(
      ({ url }) => {
        urls.push(url);
        return routedFetch(url);
      },
      async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settleRounds();
        expect(urls[0]).toContain("compare=head");
        expect(urls[0]).not.toContain("compare=branch");
      }
    );
  });

  test("names no ref while showing uncommitted work", async () => {
    // Naming any ref here would be a claim about a base this view never
    // consulted — including "vs HEAD", which reads as a comparison against the
    // last commit rather than what it is.
    await withFetch(({ url }) => routedFetch(url), async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settleRounds();
      expect(container!.textContent).toContain("2 files");
      expect(container!.textContent).not.toContain(" vs ");
    });
  });

  test("one changed file is counted as one file", async () => {
    await withFetch(({ url }) => url.includes("/changes/file") ? routedFetch(url) : Response.json({ ...LIST, files: [fileDto("src/a.ts")] }), async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settleRounds();
      expect(container!.querySelector('[data-slot="changes-toolbar"]')!.textContent).toContain("1 file");
      expect(container!.querySelector('[data-slot="changes-toolbar"]')!.textContent).not.toContain("1 files");
    });
  });

  test("on a phone the open file says where it is in the list, and going back lands on its row", async () => {
    const restore = fakePhoneWidth();
    const scrolled: string[] = [];
    // Restored from its own descriptor: HTMLElement has none (happy-dom puts
    // the method on Element), and assigning the read-through value back left
    // an own copy on HTMLElement that hid every later file's Element stub.
    const saved = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "scrollIntoView");
    window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.id); };
    try {
      await withFetch(({ url }) => routedFetch(url), async () => {
        render(<ChangesTab featureId="f1" initialFile="src/a.ts" />);
        await settleRounds();
        const position = () => container!.querySelector('[aria-label="Back to changed files"]')!.parentElement!.querySelector(".label-micro")!.textContent;
        expect(position()).toBe("1/2");
        click('[aria-label="Next file"]');
        await settleRounds();
        expect(position()).toBe("2/2");
        scrolled.length = 0;
        click('[aria-label="Back to changed files"]');
        await settleRounds();
        expect(scrolled).toContain("change-src/b.ts");
      });
    } finally {
      if (saved) Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", saved);
      else delete (window.HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      restore();
    }
  });

  test("the phone layout carries the mode into the file patch too", async () => {
    // The narrow branch renders its own ChangedFileDetail, and happy-dom is
    // 1024px wide, so without this the mobile call site is never mounted.
    const restore = fakePhoneWidth();
    const fileUrls: string[] = [];
    try {
      await withFetch(
        ({ url }) => {
          if (url.includes("/changes/file")) fileUrls.push(url);
          return routedFetch(url);
        },
        async () => {
          render(<ChangesTab featureId="f1" initialFile="src/a.ts" />);
          await settleRounds();
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
      ({ url }) => {
        urls.push(url);
        if (url.includes("compare=branch") && !url.includes("/changes/file")) {
          return Response.json(branchList());
        }
        return routedFetch(url);
      },
      async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settleRounds();

        const toggle = [...container!.querySelectorAll("button")].find(
          (b) => b.textContent?.includes("Since base")
        );
        expect(toggle).toBeTruthy();
        act(() => toggle!.click());
        await settleRounds();

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
      ({ url }) => {
        if (url.includes("/changes/file")) fileUrls.push(url);
        if (url.includes("compare=branch") && !url.includes("/changes/file")) {
          return Response.json(branchList());
        }
        return routedFetch(url);
      },
      async () => {
        render(<ChangesTab featureId="f1" initialFile="src/a.ts" />);
        await settleRounds();
        expect(fileUrls.every((u) => u.includes("compare=head"))).toBe(true);

        const toggle = [...container!.querySelectorAll("button")].find(
          (b) => b.textContent?.includes("Since base")
        );
        act(() => toggle!.click());
        await settleRounds();
        expect(fileUrls.some((u) => u.includes("compare=branch"))).toBe(true);
      }
    );
  });

  test("the empty state says which question came back empty", async () => {
    await withFetch(
      ({ url }) =>
        url.includes("/changes/file")
          ? routedFetch(url)
          : Response.json({ ...LIST, files: [], totalAdditions: 0, totalDeletions: 0 }),
      async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settleRounds();
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

/** Holds the window's zero-delay timers (the Changes hook defers each load on
 *  one) until release(), which restores the window's timers and runs them.
 *  React and the test's own settleRounds() use the global timers, not these. */
function holdZeroDelayTimers() {
  const setTimer = window.setTimeout;
  const clearTimer = window.clearTimeout;
  const held = new Map<number, () => void>();
  let nextId = -1;
  window.setTimeout = ((handler: () => void, delay?: number) => {
    if (delay) return setTimer(handler, delay);
    const id = nextId--;
    held.set(id, handler);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    if (id === undefined || !held.delete(id)) clearTimer(id);
  }) as typeof window.clearTimeout;
  return {
    held: () => held.size,
    release() {
      window.setTimeout = setTimer;
      window.clearTimeout = clearTimer;
      const handlers = [...held.values()];
      held.clear();
      for (const handler of handlers) handler();
    }
  };
}

describe("ChangesTab diff lifetime", () => {
  for (const pending of [false, true]) {
    test(`reuses ${pending ? "in-flight" : "completed"} patches when returning to a file under StrictMode`, async () => {
      const held = deferred<Response>();
      const paths: string[] = [];
      await withFetch(({ url }) => {
        if (!url.includes("/changes/file")) return Response.json(LIST);
        const path = new URL(url, "http://localhost").searchParams.get("path")!;
        paths.push(path);
        return pending && path === "src/a.ts" ? held.promise : routedFetch(url);
      }, async () => {
        render(<StrictMode><ChangesTab featureId="f1" initialFile={null} /></StrictMode>);
        await settleRounds();
        chooseFile("src/b.ts");
        await settleRounds();
        expect(detailText()).toContain("beta-line");
        chooseFile("src/a.ts");
        if (!pending) expect(detailText()).toContain("alpha-line");
        await settleRounds();
        expect(paths).toStrictEqual(["src/a.ts", "src/b.ts"]);
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
        await withFetch(({ url }) => {
          if (!url.includes("/changes/file")) { listRequests++; return Response.json(LIST); }
          const path = new URL(url, "http://localhost").searchParams.get("path")!;
          patchRequests.push(`${revision}:${path}`);
          return patchResponse(path, revision);
        }, async () => {
          render(<ChangesTab featureId="f1" initialFile="src/a.ts" />);
          await settleRounds();
          chooseFile("src/b.ts");
          await settleRounds();
          chooseFile("src/a.ts");
          await settleRounds();
          revision = "after";
          click('[aria-label="Refresh changes"]');
          expect(container!.querySelector<HTMLButtonElement>('[aria-label="Refreshing changes"]')?.disabled).toBe(true);
          await settleRounds();
          expect(detailText()).toContain("after-src/a.ts");
          expect(detailText()).not.toContain("before");
          chooseFile("src/b.ts");
          await settleRounds();
          expect(detailText()).toContain("after-src/b.ts");
          expect(patchRequests).toStrictEqual(["before:src/a.ts", "before:src/b.ts", "after:src/a.ts", "after:src/b.ts"]);
          expect(listRequests).toBe(2);
        });
      } finally { restore(); }
    });
  }

  test("a plan update refreshes patches; the work item's own changes do not", async () => {
    const originalItems = useWorkItemsStore.getState().items;
    const item: WorkItemDto = {
      id: "changes-item", featureId: "f1", projectId: "p1", title: "Changes",
      lastActivityAt: "2026-09-15T00:00:00Z",
      createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z",
      failedAt: null, failedMessage: null, failedKind: null
    };
    useWorkItemsStore.setState({ items: new Map([[item.id, item]]) });
    let revision = "working";
    let listRequests = 0;
    try {
      await withFetch(({ url }) => {
        if (!url.includes("/changes/file")) { listRequests++; return Response.json(LIST); }
        return patchResponse("src/a.ts", revision);
      }, async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settleRounds();
        act(() => useWorkItemsStore.getState().upsert({ ...item, title: "Renamed", updatedAt: "2026-09-15T00:00:01Z" }));
        await settleRounds();
        expect(listRequests).toBe(1);
        revision = "asks";
        act(() => useFeaturePlansStore.getState().upsert({ ...emptyPlan("f1"), openQuestions: ["Keep the old flag?"], updatedAt: "2026-09-15T00:00:02Z" }));
        await settleRounds();
        expect(listRequests).toBe(2);
        expect(detailText()).toContain("asks-src/a.ts");
        revision = "done";
        act(() => useFeaturePlansStore.getState().upsert({ ...emptyPlan("f1"), conclusion: "Shipped", updatedAt: "2026-09-15T00:00:03Z" }));
        await settleRounds();
        expect(listRequests).toBe(3);
        expect(detailText()).toContain("done-src/a.ts");
      });
    } finally {
      act(() => useWorkItemsStore.setState({ items: originalItems }));
      act(() => useFeaturePlansStore.setState({ plans: new Map() }));
    }
  });

  test("a plan update while a refresh is loading does not show the cancelled request as an error", async () => {
    // Its rejection is what a real fetch does on abort, so this runs on the
    // default mock: the cancelled request fails with an AbortError, and only
    // the hook's aborted check keeps that from replacing the list. The next
    // request starts on a zero-delay timer, whose first act would clear the
    // error; it is held until the cancelled request has been looked at.
    const originalItems = useWorkItemsStore.getState().items;
    const item: WorkItemDto = {
      id: "cancel-item", featureId: "f1", projectId: "p1", title: "Changes",
      lastActivityAt: "2026-09-15T00:00:00Z",
      createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z",
      failedAt: null, failedMessage: null, failedKind: null
    };
    useWorkItemsStore.setState({ items: new Map([[item.id, item]]) });
    let listRequests = 0;
    try {
      await withFetch(({ url }) => {
        if (url.includes("/changes/file")) return routedFetch(url);
        listRequests++;
        return listRequests === 2 ? new Promise<Response>(() => {}) : Response.json(LIST);
      }, async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settleRounds();
        click('[aria-label="Refresh changes"]');
        await settleRounds();
        expect(listRequests).toBe(2);
        const timers = holdZeroDelayTimers();
        try {
          act(() => useFeaturePlansStore.getState().upsert({ ...emptyPlan("f1"), conclusion: "Shipped", updatedAt: "2026-09-15T00:00:01Z" }));
          expect(timers.held()).toBe(1);
          await settleRounds();
          expect(listRequests).toBe(2);
          expect(container!.textContent).not.toContain("Retry");
          expect(container!.querySelector("aside")?.textContent).toContain("a.ts");
        } finally {
          act(() => timers.release());
        }
        await settleRounds();
        expect(listRequests).toBe(3);
        expect(container!.textContent).not.toContain("Retry");
        expect(detailText()).toContain("alpha-line");
      });
    } finally {
      act(() => useWorkItemsStore.setState({ items: originalItems }));
      act(() => useFeaturePlansStore.setState({ plans: new Map() }));
    }
  });

  test("refresh aborts old patches and late bodies cannot enter the new cache", async () => {
    const body = deferred<unknown>();
    let oldSignal: AbortSignal | null | undefined;
    let patchRequests = 0;
    await withFetch(({ url, init }) => {
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
      await settleRounds();
      expect(oldSignal?.aborted).toBe(false);
      click('[aria-label="Refresh changes"]');
      await settleRounds();
      expect(oldSignal?.aborted).toBe(true);
      expect(detailText()).toContain("current-src/a.ts");
      await act(async () => { body.resolve({ patch: "@@ -1 +1 @@\n+stale\n", truncated: true }); });
      chooseFile("src/b.ts");
      await settleRounds();
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
      await withFetch(({ url, init }) => {
        const mode = new URL(url, "http://localhost").searchParams.get("compare")!;
        if (url.includes("/changes/file")) {
          patchModes.push(mode);
          return patchResponse("src/a.ts", mode);
        }
        if (mode === "branch") { branchSignal = init?.signal; return branch.promise; }
        return Response.json(LIST);
      }, async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settleRounds();
        chooseComparison("Since base");
        await settleRounds();
        expect(branchSignal?.aborted).toBe(false);
        chooseComparison("Uncommitted");
        expect(branchSignal?.aborted).toBe(true);
        await settleRounds();
        await act(async () => {
          if (lateFailure) branch.reject(new Error("obsolete error"));
          else branch.resolve(Response.json({ ...LIST, compare: "branch", baseRef: "obsolete-base" }));
        });
        expect(detailText()).toContain("head-src/a.ts");
        expect(container!.textContent).not.toContain("obsolete");
        expect(patchModes).toStrictEqual(["head", "head"]);
      }, { ignoreAbort: true });
    });
  }

  test("changing Worker rejects the previous Worker's delayed list", async () => {
    const first = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    const patchUrls: string[] = [];
    await withFetch(({ url, init }) => {
      if (url.includes("/changes/file")) { patchUrls.push(url); return patchResponse("src/a.ts", "second-worker"); }
      if (url.includes("/features/f1/")) { signal = init?.signal; return first.promise; }
      return Response.json(LIST);
    }, async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settleRounds();
      view!.rerender(<ChangesTab featureId="f2" initialFile={null} />);
      expect(signal?.aborted).toBe(true);
      await settleRounds();
      await act(async () => { first.resolve(Response.json({ ...LIST, files: [fileDto("obsolete.ts")] })); });
      expect(detailText()).toContain("second-worker");
      expect(container!.textContent).not.toContain("obsolete.ts");
      expect(patchUrls.length).toBe(1);
      expect(patchUrls[0]).toContain("/features/f2/");
    }, { ignoreAbort: true });
  });

  for (const holdPatch of [false, true]) {
    test(`leaving the page aborts the pending ${holdPatch ? "patch" : "list"} and reopening starts fresh`, async () => {
      const held = deferred<Response>();
      let signal: AbortSignal | null | undefined;
      let reopened = false;
      await withFetch(({ url, init }) => {
        if (!reopened && url.includes("/changes/file") === holdPatch) {
          signal = init?.signal;
          return held.promise;
        }
        return routedFetch(url);
      }, async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settleRounds();
        expect(signal?.aborted).toBe(false);
        view!.rerender(null);
        expect(signal?.aborted).toBe(true);
        reopened = true;
        view!.rerender(<ChangesTab featureId="f1" initialFile={null} />);
        await settleRounds();
        await act(async () => { held.resolve(holdPatch ? patchResponse("src/a.ts", "obsolete") : Response.json({ ...LIST, files: [] })); });
        expect(detailText()).toContain("alpha-line");
        expect(container!.textContent).not.toContain("obsolete");
      }, { ignoreAbort: true });
    });
  }

  test("a patch that fails to load says so and its Retry fetches it again", async () => {
    let attempts = 0;
    await withFetch(({ url }) => {
      if (!url.includes("/changes/file")) return Response.json(LIST);
      attempts++;
      return attempts === 1 ? new Response(null, { status: 503 }) : routedFetch(url);
    }, async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settleRounds();
      const alert = container!.querySelector('[aria-label="File diff"] [data-slot="inline-error"]')!;
      expect(alert.textContent).toContain("Couldn't load this file's changes.");
      expect(alert.textContent).toContain("patch fetch failed (503)");
      act(() => alert.querySelector("button")!.click());
      await settleRounds();
      expect(detailText()).toContain("alpha-line");
      expect(attempts).toBe(2);
    });
  });

  test("a truncated patch says how to see the rest", async () => {
    await withFetch(({ url }) => url.includes("/changes/file")
      ? Response.json({ path: "src/a.ts", patch: patchFor("src/a.ts"), truncated: true, binary: false })
      : Response.json(LIST), async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settleRounds();
      expect(detailText()).toContain("Run git diff in the worker's terminal to see all of it.");
    });
  });

  test("failed patches are retryable and binary files never fetch a patch", async () => {
    let attempts = 0;
    await withFetch(({ url }) => {
      if (!url.includes("/changes/file")) return Response.json({ ...LIST, files: [LIST.files[0], { ...LIST.files[1], binary: true }] });
      attempts++;
      return attempts === 1 ? new Response(null, { status: 503 }) : routedFetch(url);
    }, async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settleRounds();
      expect(detailText()).toContain("patch fetch failed (503)");
      chooseFile("src/b.ts");
      await settleRounds();
      expect(detailText()).toContain("Binary file");
      expect(attempts).toBe(1);
      chooseFile("src/a.ts");
      await settleRounds();
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
      id: "refresh-item", featureId: "f1", projectId: "p1", title: "Changes",
      lastActivityAt: "2026-09-15T00:00:00Z",
      createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z",
      failedAt: null, failedMessage: null, failedKind: null
    };
    useWorkItemsStore.setState({ items: new Map([[item.id, item]]) });
    const refresh = deferred<Response>();
    const nextList = { ...LIST, files: [...LIST.files, fileDto("src/c.ts")] };
    let listRequests = 0;
    const patches: string[] = [];
    let revision = "before";
    try {
      await withFetch(({ url }) => {
        if (!url.includes("/changes/file")) return ++listRequests === 1 ? Response.json(nextList) : refresh.promise;
        const path = new URL(url, "http://localhost").searchParams.get("path")!;
        patches.push(path);
        return patchResponse(path, revision);
      }, async () => {
        render(<ChangesTab featureId="f1" initialFile={null} />);
        await settleRounds();
        chooseFile("src/b.ts");
        await settleRounds();
        if (automatic) act(() => useFeaturePlansStore.getState().upsert({ ...emptyPlan("f1"), conclusion: "Shipped", updatedAt: "2026-09-15T00:00:03Z" }));
        else click('[aria-label="Refresh changes"]');
        await settleRounds();
        expect(listRequests).toBe(2);
        chooseFile("src/a.ts");
        expect(detailText()).toContain("before-src/a.ts");
        chooseFile("src/b.ts");
        expect(detailText()).toContain("before-src/b.ts");
        expect(patches).toStrictEqual(["src/a.ts", "src/b.ts"]);
        chooseFile("src/c.ts");
        await settleRounds();
        expect(detailText()).toContain("before-src/c.ts");
        expect(patches).toStrictEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
        revision = "after";
        await act(async () => { refresh.resolve(Response.json(nextList)); });
        await settleRounds();
        expect(detailText()).toContain("after-src/c.ts");
        expect(patches).toStrictEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/c.ts"]);
      });
    } finally {
      act(() => useWorkItemsStore.setState({ items: originalItems }));
      act(() => useFeaturePlansStore.setState({ plans: new Map() }));
    }
  });
}

// A worker made to work in the project's own directory has no branch of its
// own, and so no base: its Changes show what is uncommitted and offer no
// choice of comparison, in any of the tab's states.
describe("ChangesTab for a worker with no branch of its own", () => {
  const toggle = () => container!.querySelector('[role="group"][aria-label="Compare against"]');
  const asked: string[] = [];
  const listed = ({ url }: { url: string }) => { asked.push(url); return routedFetch(url); };

  test("the list is shown with no choice of comparison, and only what is uncommitted is ever asked for", async () => {
    asked.length = 0;
    await withFetch(listed, async () => {
      render(<ChangesTab featureId="f1" initialFile={null} uncommittedOnly />);
      await settleRounds();
      expect(container!.textContent).toContain("alpha-line");
      expect(toggle() === null).toBe(true);
      expect(container!.textContent).not.toContain("Since base");
      expect(container!.textContent).not.toContain("Uncommitted");
      // Count, totals and Refresh are still there.
      const toolbar = container!.querySelector('[data-slot="changes-toolbar"]')!;
      expect(toolbar.textContent).toContain("2 files");
      expect(toolbar.querySelector("button")).not.toBeNull();
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.filter((url) => url.includes("compare=branch"))).toStrictEqual([]);
    });
  });

  test("a worker with a branch keeps the choice: the same tab, asked without the flag", async () => {
    await withFetch(({ url }) => routedFetch(url), async () => {
      render(<ChangesTab featureId="f1" initialFile={null} />);
      await settleRounds();
      expect([...toggle()!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Uncommitted", "Since base"]);
    });
  });

  test("while loading, on an error and with nothing changed there is no choice either", async () => {
    // Loading: the request never answers.
    await withFetch(() => new Promise<Response>(() => {}), async () => {
      render(<ChangesTab featureId="f1" initialFile={null} uncommittedOnly />);
      await settleRounds();
      expect(toggle() === null).toBe(true);
      view!.unmount();
      render(<ChangesTab featureId="f2" initialFile={null} />);
      await settleRounds();
      expect(toggle()).not.toBeNull();
      view!.unmount();
    });
    await withFetch(() => Response.json({ error: "git diff failed" }, { status: 500 }), async () => {
      render(<ChangesTab featureId="f3" initialFile={null} uncommittedOnly />);
      await settleRounds();
      expect(container!.textContent).toContain("Couldn't load changes.");
      expect(toggle() === null).toBe(true);
      view!.unmount();
    });
    await withFetch(() => Response.json({ ...LIST, files: [], totalAdditions: 0, totalDeletions: 0 }), async () => {
      render(<ChangesTab featureId="f4" initialFile={null} uncommittedOnly />);
      await settleRounds();
      expect(container!.textContent).toContain("Nothing uncommitted.");
      expect(toggle() === null).toBe(true);
    });
  });
});

describe("ChangesTab on a phone: the list, then one file at a time", () => {
  /** Spelled out in full rather than partially. */
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

  function stubFetch() {
    mockFetch(({ url }) => {
      // Real shapes (src/shared/api/routes.ts:31,90):
      //   list  /api/features/:id/changes
      //   patch /api/features/:id/changes/file?path=...
      // Match on the path segment, not on "file" anywhere in the URL — the
      // ?path= query carries file names and would match by accident.
      const body = url.includes("/changes/file") ? PATCH : CHANGES;
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    });
  }

  /** Every test mounts *inside* its `try`, with the handle declared before it.
   *  bun runs all 224 test files in one process, so a mount that throws between
   *  `fakePhoneWidth()` and the `try` would skip the restore and leak a 390px
   *  `window.innerWidth` into every later file — where it surfaces as a failure
   *  with no visible connection to this one. */
  type TabView = Awaited<ReturnType<typeof mountTab>>;

  async function mountTab(initialFile: string | null) {
    const view = await mountAsync(<ChangesTab featureId="feat_1" initialFile={initialFile} />);
    // the loader is deferred a tick on purpose (repo idiom); let it land
    await settle();
    return view;
  }

  const BACK = '[aria-label="Back to changed files"]';
  const DIFF = '[aria-label="File diff"]';
  const FILE_LIST = '[aria-label="Changed files"]';

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
    let view: TabView | null = null;
    try {
      view = await mountTab(null);
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
    let view: TabView | null = null;
    try {
      view = await mountTab("tests/mobile-chat-sheet.test.tsx");
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
    let view: TabView | null = null;
    try {
      view = await mountTab("src/client/routes/window/chat/MobileChatSheet.tsx");
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
    let view: TabView | null = null;
    try {
      view = await mountTab("src/client/routes/window/chat/MobileChatSheet.tsx");
      // Bound outside the closure: TypeScript cannot narrow `view` inside one (a
      // closure may run after a later reassignment), so `view.host` there is
      // possibly-null.
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
    let view: TabView | null = null;
    try {
      view = await mountTab("src/client/routes/window/chat/DeletedByRefetch.tsx");
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

  /** The seam between the two halves of this feature. DiffHunkView has a
   *  unified mode whose long lines scroll instead of wrapping; the phone's
   *  drill-in is the only thing that turns it on. Without this test, deleting
   *  `unified` from the <ChangedFileDetail> below leaves the whole suite green,
   *  which is why the assertion exists.
   *
   *  The first assert is deliberately one the mutation does *not* break: split
   *  mode renders the same text. It proves the patch actually loaded, so a red
   *  `diff-line` assertion means "rendered split", not "rendered nothing". */
  test("the mobile file view renders the diff unified, not split", async () => {
    stubFetch();
    const restore = fakePhoneWidth();
    let view: TabView | null = null;
    try {
      view = await mountTab("src/client/routes/window/chat/MobileChatSheet.tsx");
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
    let view: TabView | null = null;
    try {
      view = await mountTab(null);   // no fakePhoneWidth: happy-dom is 1024px
      expect(has(view.host, FILE_LIST)).toBe(true);
      expect(view.host.querySelector(FILE_LIST)!.className).toContain("w-60");
      expect(has(view.host, BACK)).toBe(false);
      // desktop still falls back to the first file, so a diff is always showing
      expect(has(view.host, DIFF)).toBe(true);
      // Per-file counts are mobile-only. Scoped to the sidebar on purpose: the
      // detail header renders the same "+31 −12" for the open file, so an
      // unscoped assertion would pass no matter what the sidebar does. In the
      // 240px sidebar these counts cost 40-66px per row and collapse the
      // directory hint — the one thing telling two same-named files apart.
      expect(view.host.querySelector(FILE_LIST)!.textContent).not.toContain("+31");
    } finally {
      view?.unmount();
    }
  });
});
