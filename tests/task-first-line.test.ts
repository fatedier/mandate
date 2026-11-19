import { expect, test } from "bun:test";
import { firstLine } from "../src/shared/task-board.js";

// The one line a card, a notice or a thread's row says of Markdown: the
// words of its first line that says something, with none of its marks.

test("the marks of bold, emphasis, code, a link and a strike are gone; their words stay", () => {
  expect(firstLine("**Shipped**: all three, see `deploy.log` and [the run](https://example.test/run), ~~not~~ *today*.\n\nMore."))
    .toBe("Shipped: all three, see deploy.log and the run, not today.");
});

test("bold against Chinese punctuation is read as bold, as the chat reads it", () => {
  expect(firstLine("**已上线**：三家门店都能下单了。")).toBe("已上线：三家门店都能下单了。");
  expect(firstLine("**12 本书都已归还**，写在目录上。")).toBe("12 本书都已归还，写在目录上。");
});

test("a heading, a list item, a numbered item and a quote say their line", () => {
  expect(["## Rewrote the guide\nAnd more.", "- first\n- second", "3. third", "> quoted **words**"].map(firstLine))
    .toEqual(["Rewrote the guide", "first", "third", "quoted words"]);
});

test("lines that say nothing are passed over: blanks, a rule, a fence's opening", () => {
  expect(firstLine("\n\n---\n\n```ts\nconst a = 1;\n```")).toBe("const a = 1;");
  expect(firstLine("   \n")).toBe("");
});

test("text with no marks is itself, signs that are not marks included", () => {
  expect(firstLine("Picked Atlas + grove.example.\n\nDetails below.")).toBe("Picked Atlas + grove.example.");
  expect(firstLine("2 * 3 * 4 = 24, and snake_case_name stays")).toBe("2 * 3 * 4 = 24, and snake_case_name stays");
});

test("a line is read as part of its block: code keeps its signs, and bold that runs on to the next line is still bold", () => {
  expect(firstLine('```py\nif __name__ == "__main__":\n    main()\n```')).toBe('if __name__ == "__main__":');
  expect(firstLine("    __indented__ = code")).toBe("__indented__ = code");
  expect(firstLine("**Shipped\ntoday**, all three.")).toBe("Shipped");
});

test("only the text's beginning is read, whole lines of it: a long text's first line is the same", () => {
  expect(firstLine(`**Done**: all of it.\n\n${"More *words* here.\n\n".repeat(2000)}`)).toBe("Done: all of it.");
  // A first line longer than the part that is read is still whole.
  const line = "x".repeat(5000);
  expect(firstLine(`**${line}** end\n\nmore`)).toBe(`${line} end`);
});

test("a line the writer broke ends there, and a table's first row is its line", () => {
  expect(firstLine("Shipped.  \nDetails below.")).toBe("Shipped.");
  expect(firstLine("| Check | Result |\n| --- | --- |\n| Build | ok |")).toBe("Check · Result");
});
