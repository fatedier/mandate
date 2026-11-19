import { expect, test } from "bun:test";
import { PaneZoomButton } from "@/components/PaneZoomButton";
import { mount } from "../helpers/mount.js";

// The button that gives a side pane the whole row, and gives the row back:
// drawn and named as what it does to the panel.

const read = (zoomed: boolean) => {
  const { host } = mount(<PaneZoomButton zoomed={zoomed} onClick={() => {}} />);
  const button = host.querySelector("button")!;
  return [button.getAttribute("aria-label"), button.getAttribute("title"), button.getAttribute("aria-pressed"), button.querySelector("svg")!.getAttribute("class")];
};

test("the enlarge button says it maximizes the panel, and restores it", () => {
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⇧Enter" : "Ctrl+Shift+Enter";
  const [label, title, pressed, icon] = read(false);
  expect([label, title, pressed]).toEqual(["Maximize panel", `Maximize panel · ${shortcut}`, "false"]);
  expect(icon).toContain("lucide-maximize-2");
  const [label2, title2, pressed2, icon2] = read(true);
  expect([label2, title2, pressed2]).toEqual(["Restore panel", `Restore panel · ${shortcut}`, "true"]);
  expect(icon2).toContain("lucide-minimize-2");
});
