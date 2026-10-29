import { describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { MarkdownView } from "@/components/MarkdownView";
import { mount, type Mounted } from "../helpers/mount.js";

let view: Mounted | null = null;
let container: HTMLElement | null = null;

function render(node: ReactNode): void {
  view = mount(node);
  container = view.host;
}

describe("MarkdownView code rendering", () => {
  test("fenced block WITHOUT a language renders as a block, not the inline pill", () => {
    render(<MarkdownView text={"```\n* Expanded API v2 coverage\n* Migrated dashboard\n```"} />);
    const pre = container!.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.className).toContain("bg-code-bg");
    // The regression: no-language fences used to fall through to the inline pill.
    expect(container!.querySelector("code.bg-muted") === null).toBe(true);
    // Bullets stay literal inside a fence (not turned into a list).
    expect(container!.querySelector("ul") === null).toBe(true);
    expect(pre!.textContent).toContain("* Expanded API v2 coverage");
  });

  test("fenced block WITH a language renders as a block", () => {
    render(<MarkdownView text={"```ts\nconst x = 1;\n```"} />);
    const pre = container!.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.className).toContain("bg-code-bg");
    expect(container!.querySelector("code")!.className).toContain("language-ts");
    // Single <pre>, not the old double-<pre> nesting.
    expect(pre!.querySelector("pre") === null).toBe(true);
  });

  test("inline code renders as the inline pill, never a block", () => {
    render(<MarkdownView text={"run `bun run test` now"} />);
    expect(container!.querySelector("pre") === null).toBe(true);
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
  // surface as the chat's).
  test("a fence with a language gets a strip naming it and a Copy button", () => {
    render(<MarkdownView text={"```ts\nconst x = 1;\n```"} />);
    const block = container!.querySelector('[data-slot="code-block"]');
    expect(block === null).toBe(false);
    for (const t of ["rounded-md", "border", "border-border-soft", "bg-code-bg"]) {
      expect(block!.className.split(/\s+/)).toContain(t);
    }
    // Corners rounded on its parts, not clipped by the block: Copy's touch
    // area reaches past the block's edge.
    expect(block!.className.split(/\s+/)).not.toContain("overflow-hidden");
    const head = block!.querySelector('[data-slot="code-head"]');
    expect(head === null).toBe(false);
    expect(head!.className.split(/\s+/)).toContain("h-7");
    expect(head!.className.split(/\s+/)).toContain("border-b");
    expect(head!.className.split(/\s+/)).toContain("rounded-t-md");
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
    for (const t of ["px-3", "py-2.5", "rounded-b-md"]) expect(pre.className.split(/\s+/)).toContain(t);
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
    // No strip above it, so the pre carries all four corners.
    expect(block.querySelector(":scope > pre")!.className.split(/\s+/)).toContain("rounded-md");
  });

  test("a fence tagged text / plain / txt is treated as unnamed — the tag says nothing", () => {
    for (const tag of ["text", "plain", "txt", "plaintext"]) {
      render(<MarkdownView text={"```" + tag + "\nx\n```"} />);
      const block = container!.querySelector('[data-slot="code-block"]')!;
      expect([tag, block.querySelector('[data-slot="code-head"]') === null]).toEqual([tag, true]);
      expect([tag, block.querySelector('button[aria-label="Copy code"]') === null]).toEqual([tag, false]);
      view!.unmount();
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
      expect(writes).toStrictEqual(["type A struct {\n\tX int\n}\n"]);
      expect(copy.textContent).toBe("Copied");
      // While it says Copied it stays visible even after the pointer leaves.
      expect(copy.className.split(/\s+/)).toContain("opacity-100");
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
      if (secure) Object.defineProperty(window, "isSecureContext", secure);
    }
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

describe("MarkdownView tables", () => {
  const PHONE_MIN = "@max-[30rem]:min-w-[28ch]";
  /** The class of the box a long cell's text sits in, or "" for a cell with none. */
  const cellClass = (text: string) =>
    [...container!.querySelectorAll("td")].find((td) => td.textContent === text)!.querySelector(":scope > .inline-block")?.className ?? "";

  test("a cell wider than 22ch keeps a minimum in a phone-width box; Han counts double", () => {
    render(<MarkdownView text={[
      "| a | b | c | d | e | f |",
      "| --- | --- | --- | --- | --- | --- |",
      "| #22 | abcdefghij klmnopqrstu | abcdefghij klmnopqrstuv | 依赖空配置文件的部署会失败 | 导入拒绝空文件 | 中文22个字宽也不算长了 |"
    ].join("\n")} />);
    // The table's scroller is the container the minimum answers to.
    expect(container!.querySelector("table")!.parentElement!.className.split(/\s+/)).toContain("@container");
    expect(cellClass("#22")).not.toContain(PHONE_MIN);
    // 22 characters exactly is not long; 23 is.
    expect(cellClass("abcdefghij klmnopqrstu")).not.toContain(PHONE_MIN);
    expect(cellClass("abcdefghij klmnopqrstuv")).toContain(PHONE_MIN);
    // 13 Han characters run 26ch wide; 7 run 14; mixed text 22ch wide is not long.
    expect(cellClass("依赖空配置文件的部署会失败")).toContain(PHONE_MIN);
    expect(cellClass("导入拒绝空文件")).not.toContain(PHONE_MIN);
    expect(cellClass("中文22个字宽也不算长了")).not.toContain(PHONE_MIN);
  });

  test("a header cell follows the same rule", () => {
    render(<MarkdownView text={"| PR | What changed in this release and why |\n| --- | --- |\n| 1 | 2 |"} />);
    const headers = [...container!.querySelectorAll("th")].map((th) => th.querySelector(":scope > .inline-block")?.className ?? "");
    expect(headers[0]).not.toContain(PHONE_MIN);
    expect(headers[1]).toContain(PHONE_MIN);
  });

  test("a short cell does not wrap, so a short Han label is not squeezed to one character a line; a long one may", () => {
    render(<MarkdownView text={"| 分类 | 主要用途 |\n| --- | --- |\n| **文件与搜索** | 读取项目文件、搜索文件内容，修改指定目录中的文件和子目录 |"} />);
    const [label, long] = [...container!.querySelectorAll("td")];
    expect(label!.className.split(/\s+/)).toContain("whitespace-nowrap");
    expect(long!.className.split(/\s+/)).not.toContain("whitespace-nowrap");
    expect(container!.querySelector("th")!.className.split(/\s+/)).toContain("whitespace-nowrap");
  });

  test("a short cell keeps its text directly in the cell; a long one wraps it in an inline box", () => {
    // A block box in every cell turned a copied row's tabs into line breaks.
    render(<MarkdownView text={"| PR | Notes |\n| --- | --- |\n| #22 | Anyone running project-1 with a short cache TTL will see reloads |"} />);
    const [short, long] = [...container!.querySelectorAll("td")];
    expect(short!.children.length).toBe(0);
    expect(short!.textContent).toBe("#22");
    expect(long!.children.length).toBe(1);
    expect(long!.firstElementChild!.tagName).toBe("SPAN");
    expect(long!.firstElementChild!.className.split(/\s+/)).toContain("inline-block");
  });

  test("width is the text's display width across the whole cell (string-width)", () => {
    // Katakana's long-vowel mark is wide although its script is Common; a flag
    // is one wide character; an accent split from its letter by emphasis still
    // belongs to it.
    render(<MarkdownView text={[
      "| a | b | c | d |",
      "| --- | --- | --- | --- |",
      `| ユーザーインターフェース | ${"\u{1F1EF}\u{1F1F5}".repeat(12)} | ${"e*\u0301*".repeat(12)} | ユーザーインター |`
    ].join("\n")} />);
    expect(cellClass("ユーザーインターフェース")).toContain(PHONE_MIN);
    expect(cellClass("\u{1F1EF}\u{1F1F5}".repeat(12))).toContain(PHONE_MIN);
    expect(cellClass("e\u0301".repeat(12))).not.toContain(PHONE_MIN);
    expect(cellClass("ユーザーインター")).not.toContain(PHONE_MIN);
  });

  test("width counts what is seen: a combining accent adds nothing", () => {
    const decomposed = (n: number) => "e\u0301".repeat(n);
    render(<MarkdownView text={`| a | b | c |\n| --- | --- | --- |\n| ${decomposed(12)} | ${"\u00e9".repeat(12)} | ${decomposed(23)} |`} />);
    expect(cellClass(decomposed(12))).not.toContain(PHONE_MIN);
    expect(cellClass("\u00e9".repeat(12))).not.toContain(PHONE_MIN);
    expect(cellClass(decomposed(23))).toContain(PHONE_MIN);
  });
});

describe("MarkdownView emphasis in Chinese, Japanese and Korean", () => {
  test("bold that ends on full-width punctuation right before Han text still closes (CommonMark alone leaves the asterisks)", () => {
    render(<MarkdownView text={"**注意：**这一步执行以后没有办法撤销。"} />);
    expect(container!.querySelector("strong")?.textContent).toBe("注意：");
    expect(container!.textContent).not.toContain("**");
  });

  test("ordinary emphasis is unchanged", () => {
    render(<MarkdownView text={"A **bold** word, *italic*, and **加粗**的中文。"} />);
    expect([...container!.querySelectorAll("strong")].map((el) => el.textContent)).toEqual(["bold", "加粗"]);
    expect(container!.querySelector("em")?.textContent).toBe("italic");
  });
});
