import { expect, test } from "bun:test";
import { shareMarkdown } from "@/routes/window/chat/share-markdown";

// The picked rows as Markdown: the user's words marked as theirs, replies as
// they were written, a gap where rows were left out.

test("the user's words are marked, replies kept as written, and a gap shows where rows were left out", () => {
  expect(shareMarkdown([
    { key: "u1", side: "user", text: "Can the gallery make thumbnails for large photos?", skipBefore: false },
    { key: "a2", side: "agent", text: "Partly:\n\n- **Same format**: yes.\n- `thumbnails: true` already does.", skipBefore: false },
    { key: "b1", side: "agent", text: "Yes, a safe first step.", skipBefore: true }
  ])).toBe("**You:** Can the gallery make thumbnails for large photos?\n\nPartly:\n\n- **Same format**: yes.\n- `thumbnails: true` already does.\n\n…\n\nYes, a safe first step.\n");
  expect(shareMarkdown([])).toBe("");
});
