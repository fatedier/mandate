import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildManagerSystemPrompt, buildWorkerSystemPrompt } from "../src/server/modules/agent/system-prompt.js";

// Every agent the user reads is told how to link a file so the page opens it:
// a Markdown link to its absolute path, `#L` for lines.

const personal = fs.readFileSync(path.join(process.cwd(), "src/server/modules/personal/prompts/personal.md"), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const RULE = "When you want the user to read a file, link it with its absolute path: `[name](/absolute/path)`, adding `#L<line>` or `#L<first>-L<last>` to point at lines; put a path with spaces in angle brackets: `[name](</absolute/path with spaces>)`. The user opens it in the page; a path in backticks is not a link.";

test("managers, workers and the personal agent are told to link a file with its absolute path", () => {
  for (const [who, prompt] of [["manager", buildManagerSystemPrompt()], ["worker", buildWorkerSystemPrompt()], ["personal", personal]] as const) {
    expect([who, flat(prompt).includes(RULE)]).toEqual([who, true]);
  }
});
