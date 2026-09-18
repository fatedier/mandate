import { expect, test } from "bun:test";
import { paneHrefFor } from "@/routes/terminal/pane-href";

// Slugs carry characters that must be encoded in a path segment: the pane id
// starts with "%", the feature name has a "/" and a space.
const PROJECT = {
  tmuxSessionName: "md frp",
  features: [{ tmuxWindowName: "issue/5460" }, { tmuxWindowName: "main" }]
};

test("entered through a feature route, a window that is one of the project's features keeps the feature route (§8.2)", () => {
  expect(paneHrefFor({ isStandalone: false, project: PROJECT, sessionName: "md frp", windowName: "issue/5460", paneId: "%30" }))
    .toBe("/projects/md%20frp/features/issue%2F5460/pane/%2530");
});

test("entered through a feature route, a window that is not a feature falls back to the session route", () => {
  expect(paneHrefFor({ isStandalone: false, project: PROJECT, sessionName: "md frp", windowName: "zsh", paneId: "%1" }))
    .toBe("/sessions/md%20frp/windows/zsh/pane/%251");
});

test("standalone (session-rooted) always builds the session route, even for a feature window", () => {
  expect(paneHrefFor({ isStandalone: true, project: PROJECT, sessionName: "md frp", windowName: "issue/5460", paneId: "%30" }))
    .toBe("/sessions/md%20frp/windows/issue%2F5460/pane/%2530");
});

test("a pane in another session takes the session route even on a feature route with a matching window name", () => {
  expect(paneHrefFor({ isStandalone: false, project: PROJECT, sessionName: "other", windowName: "issue/5460", paneId: "%30" }))
    .toBe("/sessions/other/windows/issue%2F5460/pane/%2530");
});
