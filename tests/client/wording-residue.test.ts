import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { provenanceForWake } from "@/routes/window/chat/chatProvenance";
import { sourceFiles } from "../helpers/source-files.js";

// Names the screen no longer uses. Each check reads the client's copy only
// (string literals and JSX text), so code that keeps the old name is not hit.

test("the cause lines over a reply name the worker", () => {
  expect(provenanceForWake("sweep")?.label).toBe("Worker check");
});

test("no user-visible text in the client says work item", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles("src/client", /\.tsx?$/)) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      // Strings and JSX text only: identifiers (workItem, WorkItem…), import
      // paths (work-items) and wake reasons (sweep) are code,
      // not copy. A comment is not copy either.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const copy = line.match(/(["'`])(?:(?!\1).)*\1|>[^<{]*</g) ?? [];
      if (copy.some((s) => /work[ -]item/i.test(s) && !/work-items|work-item-[a-z]/.test(s))) {
        offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  expect(offenders).toStrictEqual([]);
});
