import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles } from "./helpers/source-files.js";

const GONE = [
  "createSideThread", "closeSideThread", "startSideConversation", "closeSideConversation",
  "transferSideSummary", "retargetSideSummary", "getSideSummaryDraft", "summarizeSideConversation",
  "agentThreadForks", "agentThreadTransfers", "agentSideTransferRetarget", "agentThreadSummaryDraft",
  "agentSideTransferUpdated", "SIDE_SYSTEM_INSTRUCTIONS", "closeOpenEphemeralSideThreads", "sideThreadId"
];

test("side conversations are gone from the code (history rows still render)", () => {
  const root = path.resolve(import.meta.dir, "../src");
  const hits: string[] = [];
  for (const file of sourceFiles(root, /\.(ts|tsx)$/)) {
    const text = readFileSync(file, "utf8");
    for (const name of GONE) if (text.includes(name)) hits.push(`${path.relative(root, file)}: ${name}`);
  }
  expect(hits).toStrictEqual([]);
});
