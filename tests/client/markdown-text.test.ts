import { expect, test } from "bun:test";
import { markdownToRuns, markdownToText } from "@/lib/markdown-text";

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
    cases: [["Which flour?\n\n- rye-type-1\n- wheat-type-2", "Which flour?\nrye-type-1\nwheat-type-2"], ["## Plan\n\nShip it.", "Plan\nShip it."]]
  },
  {
    // A code block is kept as written: its indentation is its meaning.
    name: "a code block keeps its indentation, its first line too",
    cases: [["Set these:\n\n```yaml\n  retries: 3\n  timeout: 10\n```", "Set these:\n  retries: 3\n  timeout: 10"], ["```\n  a\n  b\n```", "  a\n  b"]]
  },
  {
    // A line the writer broke (two spaces, or a backslash, before the line's
    // end) stays two lines: the words either side do not run together.
    name: "a hard break is a line break, in a paragraph, a quote and a list item",
    cases: [
      ["Shipped.  \nDetails below.", "Shipped.\nDetails below."],
      ["Shipped.\\\nDetails below.", "Shipped.\nDetails below."],
      ["> One  \n> two", "One\ntwo"],
      ["- first  \n  still first\n- second", "first\nstill first\nsecond"]
    ]
  },
  {
    name: "a table's row is one line, its cells told apart",
    cases: [["| Check | Result |\n| --- | --- |\n| Build | **ok** |\n| Lint |  |", "Check · Result\nBuild · ok\nLint"]]
  },
  {
    name: "markup with no words in it reads as nothing",
    cases: [["```", ""], ["---", ""], ["", ""]]
  }
];

test.each(rows)("$name", ({ cases }) => {
  for (const [markdown, text] of cases) expect(markdownToText(markdown)).toBe(text);
});

// A worker's card draws its question as one line with its links kept: the
// same words as markdownToText, split where a link begins and ends.
test("markdownToRuns: markdownToText's words, its links kept as links, a canvas's path bare or as code among them", () => {
  const cases: Array<[string, Array<{ text: string; href?: string }>]> = [
    ["Roll out **staged** per [Rollout plan](/canvas/cnv_qwertyAsdf1), keeping `cache.ttl`?", [
      { text: "Roll out staged per " }, { text: "Rollout plan", href: "/canvas/cnv_qwertyAsdf1" }, { text: ", keeping cache.ttl?" }
    ]],
    ["See /canvas/cnv_qwertyAsdf1 now", [{ text: "See " }, { text: "/canvas/cnv_qwertyAsdf1", href: "/canvas/cnv_qwertyAsdf1" }, { text: " now" }]],
    ["`/canvas/cnv_qwertyAsdf1`", [{ text: "/canvas/cnv_qwertyAsdf1", href: "/canvas/cnv_qwertyAsdf1" }]],
    ["Follow [the plan][p] first?\n\n[p]: /canvas/cnv_qwertyAsdf1", [
      { text: "Follow " }, { text: "the plan", href: "/canvas/cnv_qwertyAsdf1" }, { text: " first?" }
    ]],
    ["Pick one:\n\n- one\n- see [the log](https://example.com/log)", [
      { text: "Pick one:" }, { text: "\n" }, { text: "one" }, { text: "\n" }, { text: "see " }, { text: "the log", href: "https://example.com/log" }
    ]]
  ];
  for (const [markdown, runs] of cases) {
    expect(markdownToRuns(markdown)).toEqual(runs);
    expect(markdownToRuns(markdown).map((run) => run.text).join("")).toBe(markdownToText(markdown));
  }
});

// Whatever the markdown holds, the runs say the same words: HTML written as a
// block among them.
test("markdownToRuns says markdownToText's words for any question: a block of HTML too", () => {
  for (const markdown of [
    "<details><summary>May I proceed?</summary></details>",
    "Ship it?\n\n<div>See the notes</div>\n\n```\nnpm run release\n```",
    "Shipped.  \nDetails are [here](https://example.com/details).",
    "| Check | Result |\n| --- | --- |\n| Build | see [the log](https://example.com/log) |\n| Lint |  |",
    "Read the [release notes](/canvas/cnv_qwertyAsdf1) before shipping?"
  ]) {
    expect(markdownToRuns(markdown).map((run) => run.text).join("")).toBe(markdownToText(markdown));
  }
});
