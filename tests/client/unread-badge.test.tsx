import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UnreadBadge } from "@/components/UnreadBadge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(count: number, className?: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<UnreadBadge count={count} className={className} />);
  });
  return host!.querySelector('[data-slot="unread-badge"]');
}

test("zero renders nothing", () => {
  expect(render(0) === null).toBe(true);
  act(() => root?.unmount());
  host?.remove();
  expect(render(-3) === null).toBe(true);
});

test("counts show as digits, capped at 99+", () => {
  expect(render(7)?.textContent).toBe("7");
  act(() => root?.unmount());
  host?.remove();
  expect(render(150)?.textContent).toBe("99+");
});

test("one tint spelling, placement from className", () => {
  const el = render(3, "absolute -top-1 -right-1")!;
  const classes = el.className.split(/\s+/);
  for (const c of ["bg-status-review/20", "text-status-review", "rounded-full", "num", "absolute", "-top-1"]) expect(classes).toContain(c);
});
