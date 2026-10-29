import { expect, test } from "bun:test";
import { paneHrefFor, terminalBackHref, terminalPlace } from "@/routes/terminal/pane-href";

// Slugs carry characters that must be encoded in a path segment: the pane id
// starts with "%", the feature name has a "/" and a space.
const PROJECT = {
  tmuxSessionName: "md project-1",
  features: [{ tmuxWindowName: "issue/39" }, { tmuxWindowName: "main" }]
};

const hrefRows: Array<{ name: string; isStandalone: boolean; sessionName: string; windowName: string; paneId: string; href: string }> = [
  {
    name: "entered through a feature route, a window that is one of the project's features keeps the feature route",
    isStandalone: false, sessionName: "md project-1", windowName: "issue/39", paneId: "%30",
    href: "/projects/md%20project-1/features/issue%2F39/pane/%2530"
  },
  {
    name: "entered through a feature route, a window that is not a feature falls back to the session route",
    isStandalone: false, sessionName: "md project-1", windowName: "zsh", paneId: "%1",
    href: "/sessions/md%20project-1/windows/zsh/pane/%251"
  },
  {
    name: "standalone (session-rooted) always builds the session route, even for a feature window",
    isStandalone: true, sessionName: "md project-1", windowName: "issue/39", paneId: "%30",
    href: "/sessions/md%20project-1/windows/issue%2F39/pane/%2530"
  },
  {
    name: "a pane in another session takes the session route even on a feature route with a matching window name",
    isStandalone: false, sessionName: "other", windowName: "issue/39", paneId: "%30",
    href: "/sessions/other/windows/issue%2F39/pane/%2530"
  }
];

test.each(hrefRows)("$name", ({ isStandalone, sessionName, windowName, paneId, href }) => {
  expect(paneHrefFor({ isStandalone, project: PROJECT, sessionName, windowName, paneId })).toBe(href);
});

// The terminal page's title links back to where its pane lives. Route params
// arrive decoded, so a name with "#", "?", "/" or a space must be encoded
// again, or "#one" becomes a fragment and the link opens window "build".
test("the terminal's back link leads to the Sessions window, its names encoded", () => {
  expect(terminalBackHref({ isStandalone: true, projectSlug: undefined, featureSlug: undefined, sessionName: "demo", windowName: "build#one" }))
    .toBe("/sessions/demo/windows/build%23one");
  expect(terminalBackHref({ isStandalone: true, projectSlug: undefined, featureSlug: undefined, sessionName: "md project-1", windowName: "x/y?z" }))
    .toBe("/sessions/md%20project-1/windows/x%2Fy%3Fz");
});

test("entered through a feature route, the back link leads to the worker's Terminal tab", () => {
  expect(terminalBackHref({ isStandalone: false, projectSlug: "md project-1", featureSlug: "issue/39", sessionName: "md project-1", windowName: "issue/39" }))
    .toBe("/projects/md%20project-1/features/issue%2F39?tab=terminal");
});

// What the terminal page's title names and links to. A Sessions pane takes
// the live lookup's names (its window can be renamed while open); the lookup
// answers only for the routed pane (standalone-pane-lookup.test.tsx).
const sessionsRoute = { isStandalone: true, projectSlug: undefined, featureSlug: undefined, featureName: undefined, sessionName: "demo", windowName: "beta" };

test("a Sessions pane's title follows its window's live name", () => {
  expect(terminalPlace({ ...sessionsRoute, lookup: { sessionName: "demo", windowName: "beta-renamed" } }))
    .toEqual({ name: "beta-renamed", backHref: "/sessions/demo/windows/beta-renamed" });
});

test("with no lookup yet, or the pane gone, the route names the place", () => {
  expect(terminalPlace({ ...sessionsRoute, lookup: null }))
    .toEqual({ name: "beta", backHref: "/sessions/demo/windows/beta" });
});

test("a worker's pane is named by its feature, by its route slug until the projects load", () => {
  const route = { isStandalone: false, lookup: null, projectSlug: "md project-1", featureSlug: "issue/39", sessionName: "md project-1", windowName: "issue/39" };
  expect(terminalPlace({ ...route, featureName: "Issue 39" }))
    .toEqual({ name: "Issue 39", backHref: "/projects/md%20project-1/features/issue%2F39?tab=terminal" });
  expect(terminalPlace({ ...route, featureName: undefined }).name).toBe("issue/39");
});
