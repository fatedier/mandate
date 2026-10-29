import { expect, test } from "bun:test";
import { markdownToText } from "@/lib/markdown-text";

// One line of a worker's markdown, read as the words it says: the
// same parser the chat renders with, so what is bold there is bold here.
const rows: Array<{ name: string; cases: Array<[markdown: string, text: string]> }> = [
  {
    name: "inline marks go and their words stay",
    cases: [
      ["Checked one by one: **items 3 and 7 are both done, and the import part is finished**.", "Checked one by one: items 3 and 7 are both done, and the import part is finished."],
      ["Updated **[the import guide](https://example.com/docs/import)**, examples are in `samples`, `3` files changed.", "Updated the import guide, examples are in samples, 3 files changed."],
      ["Shortened [the report](/canvas/cnv_Kl9zXc8vBn4): the body is about **400 words**.", "Shortened the report: the body is about 400 words."],
      ["Done: *two* files, ~~three~~ `go vet` runs.", "Done: two files, three go vet runs."],
      ["Nothing to mark here.", "Nothing to mark here."]
    ]
  },
  {
    name: "a heading, a list item and a quote read as their words",
    cases: [
      ["## Conclusion: it can ship as planned", "Conclusion: it can ship as planned"],
      ["- Finished `make check`", "Finished make check"],
      ["> The doc links are not checked yet", "The doc links are not checked yet"]
    ]
  },
  {
    // CommonMark alone leaves these stars in the text: a closing ** after a
    // bracket and before a Han character is not "right-flanking". The chat reads
    // it as bold (remark-cjk-friendly), so this must too.
    name: "bold closed between a bracket and Han text is read as the chat reads it",
    cases: [["已确认**两处都已修复（含回归）**后提交。", "已确认两处都已修复（含回归）后提交。"]]
  },
  {
    name: "a bare URL and a GFM autolink keep their text",
    cases: [["see https://github.com/acmecorp/project-1/pull/64 for the notes", "see https://github.com/acmecorp/project-1/pull/64 for the notes"]]
  },
  {
    // A paragraph and the list under it are two things: their words do not run together.
    name: "blocks keep a break between them",
    cases: [["Which region?\n\n- us-east-1\n- eu-west-1", "Which region?\nus-east-1\neu-west-1"], ["## Plan\n\nShip it.", "Plan\nShip it."]]
  },
  {
    // A code block is kept as written: its indentation is its meaning.
    name: "a code block keeps its indentation, its first line too",
    cases: [["Set these:\n\n```yaml\n  retries: 3\n  timeout: 10\n```", "Set these:\n  retries: 3\n  timeout: 10"], ["```\n  a\n  b\n```", "  a\n  b"]]
  },
  {
    name: "markup with no words in it reads as nothing",
    cases: [["```", ""], ["---", ""], ["", ""]]
  }
];

test.each(rows)("$name", ({ cases }) => {
  for (const [markdown, text] of cases) expect(markdownToText(markdown)).toBe(text);
});
