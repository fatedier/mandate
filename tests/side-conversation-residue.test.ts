import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles } from "./helpers/source-files.js";

const GONE = [
  "createSideThread", "closeSideThread", "startSideConversation", "closeSideConversation",
  "transferSideSummary", "retargetSideSummary", "getSideSummaryDraft", "summarizeSideConversation",
  "agentThreadForks", "agentThreadTransfers", "agentSideTransferRetarget", "agentThreadSummaryDraft",
  "agentSideTransferUpdated", "SIDE_SYSTEM_INSTRUCTIONS", "closeOpenEphemeralSideThreads", "sideThreadId",
  // The in-memory side chat, before side chats were threads.
  "SideChatManager", "sideChatPatch", "sideChatBusy", "sideChatHandoffReady", "sideChatHandoffFailed",
  "createSideChatHandoff", "SideChatHandoffStatus", "SIDE_CHAT_ENDED", "ctx.ephemeral", "side_chat_summary"
];

test("side conversations and the in-memory side chat are gone from the code (history rows still render)", () => {
  const root = path.resolve(import.meta.dir, "../src");
  const hits: string[] = [];
  for (const file of sourceFiles(root, /\.(ts|tsx)$/)) {
    const text = readFileSync(file, "utf8");
    for (const name of GONE) if (text.includes(name)) hits.push(`${path.relative(root, file)}: ${name}`);
  }
  expect(hits).toStrictEqual([]);
});
