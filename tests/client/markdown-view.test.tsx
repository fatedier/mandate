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
    expect(pre!.className).toContain("bg-code-bg");
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
    expect(pre!.className).toContain("bg-code-bg");
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
    expect(container!.querySelector("pre")!.className).toContain("bg-code-bg");
  });
});

describe("MarkdownView code block strip", () => {
  // The block is a lifted card with a language strip and a Copy button, so it
  // separates from the chat background by structure, not by how far its fill
  // sits from the page (a sunk fill a few steps darker read as the same
  // surface — the user's "the code background and the chat background are too
  // close").
  test("a fence with a language gets a strip naming it and a Copy button", () => {
    render(<MarkdownView text={"```ts\nconst x = 1;\n```"} />);
    const block = container!.querySelector('[data-slot="code-block"]');
    expect(block === null).toBe(false);
    for (const t of ["rounded-md", "border", "border-border-soft", "overflow-hidden", "bg-code-bg"]) {
      expect(block!.className.split(/\s+/)).toContain(t);
    }
    const head = block!.querySelector('[data-slot="code-head"]');
    expect(head === null).toBe(false);
    expect(head!.className.split(/\s+/)).toContain("h-7");
    expect(head!.className.split(/\s+/)).toContain("border-b");
    expect(head!.querySelector('[data-slot="code-lang"]')!.textContent).toBe("ts");
    const copy = head!.querySelector('button[aria-label="Copy code"]');
    expect(copy === null).toBe(false);
    expect(copy!.textContent).toBe("Copy");
    // Copy is revealed, not shown: hidden until the block is hovered or the
    // button is focused; touch screens have no hover, so it stays visible
    // there. The block is the hover group.
    for (const t of ["group", "relative"]) expect(block!.className.split(/\s+/)).toContain(t);
    for (const t of ["opacity-0", "group-hover:opacity-100", "focus-visible:opacity-100", "pointer-coarse:opacity-100"]) {
      expect(copy!.className.split(/\s+/)).toContain(t);
    }
    expect(copy!.className.split(/\s+/)).not.toContain("absolute");
    // The pre is the strip's sibling inside the block, not nested in it.
    const pre = block!.querySelector(":scope > pre")!;
    expect(pre === null).toBe(false);
    expect(head!.querySelector("pre") === null).toBe(true);
    // Block code is 13px mono on a 1.55 line, padded 10/12 — at the prose's
    // 14px the mono face reads larger than the prose around it, and a
    // one-line fence stood 76px tall.
    for (const t of ["px-3", "py-2.5"]) expect(pre.className.split(/\s+/)).toContain(t);
    expect(pre.className.split(/\s+/)).not.toContain("p-3");
    const code = pre.querySelector("code")!;
    for (const t of ["font-mono", "text-xs", "leading-[1.55]"]) expect(code.className.split(/\s+/)).toContain(t);
    expect(code.className.split(/\s+/)).not.toContain("text-sm");
  });

  test("a fence without a language has no strip; Copy floats in the block's corner", () => {
    render(<MarkdownView text={"```\nplain\n```"} />);
    const block = container!.querySelector('[data-slot="code-block"]')!;
    expect(block.querySelector('[data-slot="code-head"]') === null).toBe(true);
    const copy = block.querySelector('button[aria-label="Copy code"]')!;
    expect(copy === null).toBe(false);
    for (const t of ["absolute", "opacity-0", "group-hover:opacity-100", "pointer-coarse:opacity-100"]) {
      expect(copy.className.split(/\s+/)).toContain(t);
    }
  });

  test("a fence tagged text / plain / txt is treated as unnamed — the tag says nothing", () => {
    for (const tag of ["text", "plain", "txt", "plaintext"]) {
      render(<MarkdownView text={"```" + tag + "\nx\n```"} />);
      const block = container!.querySelector('[data-slot="code-block"]')!;
      expect([tag, block.querySelector('[data-slot="code-head"]') === null]).toEqual([tag, true]);
      expect([tag, block.querySelector('button[aria-label="Copy code"]') === null]).toEqual([tag, false]);
      act(() => root!.unmount());
      container!.remove();
      root = null;
      container = null;
    }
    // A real language still names itself, in a strip.
    render(<MarkdownView text={"```go\nx\n```"} />);
    expect(container!.querySelector('[data-slot="code-head"] [data-slot="code-lang"]')!.textContent).toBe("go");
  });

  test("Copy writes the fence's text, not its markdown, and flips to Copied", async () => {
    const writes: string[] = [];
    const nav = navigator as unknown as { clipboard?: { writeText: (t: string) => Promise<void> } };
    const original = nav.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => { writes.push(t); } }
    });
    const secure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    try {
      render(<MarkdownView text={"```go\ntype A struct {\n\tX int\n}\n```"} />);
      const copy = container!.querySelector('button[aria-label="Copy code"]') as HTMLButtonElement;
      await act(async () => {
        copy.click();
      });
      expect(writes).toEqual(["type A struct {\n\tX int\n}\n"]);
      expect(copy.textContent).toBe("Copied");
      // While it says Copied it stays visible even after the pointer leaves.
      expect(copy.className.split(/\s+/)).toContain("opacity-100");
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
      if (secure) Object.defineProperty(window, "isSecureContext", secure);
    }
  });

  test("inline code has no strip", () => {
    render(<MarkdownView text={"run `bun run test` now"} />);
    expect(container!.querySelector('[data-slot="code-head"]') === null).toBe(true);
  });
});

describe("MarkdownView root size", () => {
  test("the non-dense root is the transcript's 14px body, not 16px", () => {
    // The chat wrapper says `text-sm leading-[1.6]`, but this root sets its own
    // size and wins over the inherited one, so it has to say the same thing.
    render(<MarkdownView text={"plain prose"} />);
    const tokens = (container!.firstElementChild as HTMLElement).className.split(/\s+/);
    expect(tokens).toContain("text-sm");
    expect(tokens).not.toContain("text-base");
  });
});
