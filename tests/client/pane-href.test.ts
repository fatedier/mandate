import { expect, test } from "bun:test";
import { paneHrefFor, terminalBackHref, terminalPlace } from "@/routes/terminal/pane-href";

// Slugs carry characters that must be encoded in a path segment: the pane id
// starts with "%", the worker name has a "/" and a space.
const PROJECT = {
  tmuxSessionName: "md project-1",
  workers: [{ tmuxWindowName: "issue/39" }, { tmuxWindowName: "main" }]
};

const hrefRows: Array<{ name: string; sessionName: string; windowName: string; paneId: string; href: string }> = [
  {
    name: "a window that is one of the project's workers keeps the worker route",
    sessionName: "md project-1", windowName: "issue/39", paneId: "%30",
    href: "/projects/md%20project-1/workers/issue%2F39/pane/%2530"
  },
  {
    name: "a window that is not a worker opens on the Terminals page",
    sessionName: "md project-1", windowName: "zsh", paneId: "%1",
    href: "/terminals/pane/%251"
  },
  {
    name: "a pane in another session opens on the Terminals page even with a matching window name",
    sessionName: "other", windowName: "issue/39", paneId: "%30",
    href: "/terminals/pane/%2530"
  }
];

test.each(hrefRows)("$name", ({ sessionName, windowName, paneId, href }) => {
  expect(paneHrefFor({ project: PROJECT, sessionName, windowName, paneId })).toBe(href);
});

test("a Terminals address names the pane's pid when it is known", () => {
  expect(paneHrefFor({ project: PROJECT, sessionName: "other", windowName: "zsh", paneId: "%1", pid: 7 })).toBe("/terminals/pane/%251?pid=7");
});

test("a worker terminal's back link leads to the worker's Terminal tab in its thread", () => {
  expect(terminalBackHref({ id: "wkr_39", ownerThreadId: "thr_9" })).toBe("/threads/thr_9?worker=wkr_39&tab=terminal");
  // Before the projects load, or a worker without a thread: the projects.
  expect(terminalBackHref(null)).toBe("/projects");
  expect(terminalBackHref({ id: "wkr_39", ownerThreadId: null })).toBe("/projects");
});

test("a worker's pane is named by its worker, by its route slug until the projects load", () => {
  expect(terminalPlace({ workerSlug: "issue/39", workerName: "Issue 39", worker: { id: "wkr_39", ownerThreadId: "thr_9" } }))
    .toEqual({ name: "Issue 39", backHref: "/threads/thr_9?worker=wkr_39&tab=terminal" });
  expect(terminalPlace({ workerSlug: "issue/39", workerName: undefined }).name).toBe("issue/39");
});
