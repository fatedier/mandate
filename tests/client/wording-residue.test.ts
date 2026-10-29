import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { provenanceForWake } from "@/routes/window/chat/chatProvenance";
import { sourceFiles } from "../helpers/source-files.js";

// Names the screen no longer uses. Each check reads the client's copy only
// (string literals and JSX text), so code that keeps the old name is not hit.

// The screen calls it a worker. The entity keeps its name
// in code, the API and the tools, so this is not a sweep of the client: it
// pins the files whose copy named the worker a feature, where nothing on
// screen should say so again.
const FILES = [
  "src/client/routes/settings/RoutingPane.tsx",
  "src/client/routes/projects/SetupChecklist.tsx",
  "src/client/routes/window/FeatureActionsMenu.tsx",
  "src/client/routes/window/chat/chatProvenance.ts",
  "src/client/routes/window/chat/tool-details/targets.tsx"
];

test("the copy in these files never calls a worker a feature", () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      // Strings and JSX text only, as the work item check below does: an
      // identifier (featureId, Feature), an import path or a comment is code.
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || /^\s*import /.test(line)) return;
      const copy = line.match(/(["'`])(?:(?!\1).)*\1|>[^<{]*</g) ?? [];
      // A lone lowercase word is a key or a kind ("feature", "feature-event"), not a sentence.
      if (copy.some((s) => /\bfeatures?\b/i.test(s) && !/^["'`][a-z-]+["'`]$/.test(s))) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 110)}`);
    });
  }
  expect(offenders).toStrictEqual([]);
});

test("the cause lines over a reply name the worker", () => {
  expect(provenanceForWake("work-item-heartbeat")?.label).toBe("Worker check");
});

test("no user-visible text in the client says work item", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles("src/client", /\.tsx?$/)) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      // Strings and JSX text only: identifiers (workItem, WorkItem…), import
      // paths (work-items) and wake reasons (work-item-heartbeat) are code,
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
