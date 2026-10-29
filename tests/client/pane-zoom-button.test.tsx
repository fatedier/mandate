import { afterEach, expect, test } from "bun:test";
import { PaneZoomButton } from "@/components/PaneZoomButton";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

// The button that gives a side pane the whole row does it by folding the
// chat away: it says so, and its pair beside it (Hide panel) says the other.

afterEach(() => { runCleanups(); });

const read = (zoomed: boolean) => {
  const { host } = mount(<PaneZoomButton zoomed={zoomed} onClick={() => {}} />);
  const button = host.querySelector("button")!;
  return [button.getAttribute("aria-label"), button.getAttribute("title"), button.getAttribute("aria-pressed"), button.querySelector("svg")!.getAttribute("class")];
};

test("the enlarge button says it hides the chat, and shows it again", () => {
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⇧Enter" : "Ctrl+Shift+Enter";
  const [label, title, pressed, icon] = read(false);
  expect([label, title, pressed]).toEqual(["Hide chat", `Hide chat · ${shortcut}`, "false"]);
  expect(icon).toContain("lucide-panel-left-close");
  const [label2, title2, pressed2, icon2] = read(true);
  expect([label2, title2, pressed2]).toEqual(["Show chat", `Show chat · ${shortcut}`, "true"]);
  expect(icon2).toContain("lucide-panel-left-open");
});
