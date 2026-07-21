import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownView } from "@/components/MarkdownView";

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

describe("MarkdownView code rendering", () => {
  test("fenced block WITHOUT a language renders as a block, not the inline pill", () => {
    render(<MarkdownView text={"```\n* Expanded API v2 coverage\n* Migrated dashboard\n```"} />);
    const pre = container!.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.className).toContain("bg-terminal-bg");
    // The regression: no-language fences used to fall through to the inline pill.
    expect(container!.querySelector("code.bg-muted")).toBeNull();
    // Bullets stay literal inside a fence (not turned into a list).
    expect(container!.querySelector("ul")).toBeNull();
    expect(pre!.textContent).toContain("* Expanded API v2 coverage");
  });

  test("fenced block WITH a language renders as a block", () => {
    render(<MarkdownView text={"```ts\nconst x = 1;\n```"} />);
    const pre = container!.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.className).toContain("bg-terminal-bg");
    expect(container!.querySelector("code")!.className).toContain("language-ts");
    // Single <pre>, not the old double-<pre> nesting.
    expect(pre!.querySelector("pre")).toBeNull();
  });

  test("inline code renders as the inline pill, never a block", () => {
    render(<MarkdownView text={"run `bun run test` now"} />);
    expect(container!.querySelector("pre")).toBeNull();
    const code = container!.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.className).toContain("bg-muted");
    expect(code!.textContent).toBe("bun run test");
  });

  test("real markdown around a fence still renders (list + fence coexist)", () => {
    render(<MarkdownView text={"- one\n- two\n\n```\nliteral\n```"} />);
    expect(container!.querySelector("ul")).not.toBeNull();
    expect(container!.querySelectorAll("li").length).toBe(2);
    expect(container!.querySelector("pre")!.className).toContain("bg-terminal-bg");
  });
});
