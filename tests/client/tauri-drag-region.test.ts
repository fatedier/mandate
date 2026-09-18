import { afterEach, expect, test } from "bun:test";
import { installTauriDragRegion } from "@/shell/tauri-drag-region";

let uninstall: (() => void) | null = null;
afterEach(() => { uninstall?.(); uninstall = null; document.body.innerHTML = ""; });

function mount(html: string) {
  document.body.innerHTML = html;
}
function press(el: Element, init: MouseEventInit = {}) {
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1, ...init });
  el.dispatchEvent(event);
  return event;
}

test("a mousedown on a child of a drag region starts dragging", () => {
  const calls: number[] = [];
  uninstall = installTauriDragRegion(document, () => { calls.push(1); });
  mount('<header data-tauri-drag-region><h1 id="t">Title</h1></header>');
  const event = press(document.getElementById("t")!);
  expect(calls.length).toBe(1);
  expect(event.defaultPrevented).toBe(true);
});

test("interactive descendants, the region itself, right clicks and double clicks are left alone", () => {
  const calls: number[] = [];
  uninstall = installTauriDragRegion(document, () => { calls.push(1); });
  mount('<header id="h" data-tauri-drag-region><button id="b">x</button><h1 id="t">Title</h1></header><div id="out">outside</div>');
  press(document.getElementById("b")!);
  press(document.getElementById("h")!);           // built-in handler owns this
  press(document.getElementById("t")!, { button: 2 });
  press(document.getElementById("t")!, { detail: 2 });
  press(document.getElementById("out")!);
  expect(calls.length).toBe(0);
});
