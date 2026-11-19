import { expect, test } from "bun:test";
import type { Config } from "../src/server/config.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";
import type { ResolvedProviderConfig } from "../src/server/config/types.js";
import { activeToolReviewRules, buildManagerInitialContext, buildWorkerInitialContext } from "../src/server/modules/agent/system-prompt.js";

// While the tool-call review is on, every agent reads the user's rules for
// it, and the review counts them as the user's words: what they allow needs
// no asking, what they say needs the user's word needs it.

const RULES = "Agents may push their own feature branches.\nAsk me before anything touches production.";
const chat = { provider: "gw", model: "deepseek/deepseek-flash" } as ResolvedProviderConfig;

function config(agent: Partial<Config["agent"]>): Config {
  return { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, decisionsEnabled: true, decisions: chat, decisionsFallbacks: [], ...agent } };
}

const SECTION = [
  "## Your user's rules for risky steps",
  "",
  RULES,
  "",
  "What these rules allow you may do without asking; what they say needs the user's word needs it. A reviewer checks risky steps against them."
].join("\n");

const worker = {
  project: { id: "p1", name: "shop", workingDir: "/work/shop", isGit: true, gitRemote: null, tmuxSessionName: "shop" },
  worker: { id: "f1", name: "cleanup", tmuxWindowName: "cleanup", mode: "existing", branch: null, baseRef: null, worktreePath: null }
} as Parameters<typeof buildWorkerInitialContext>[0];

test("agents read the user's rules only while the review is on", () => {
  // Off, on without a second look (so not running), or on with no rules: nothing to read.
  expect(activeToolReviewRules(config({ toolReviewEnabled: false, toolReviewRules: RULES }))).toBe("");
  expect(activeToolReviewRules(config({ toolReviewEnabled: true, toolReviewRules: RULES, decisionsEnabled: false }))).toBe("");
  expect(activeToolReviewRules(config({ toolReviewEnabled: true, toolReviewRules: "  " }))).toBe("");
  const on = activeToolReviewRules(config({ toolReviewEnabled: true, toolReviewRules: `  ${RULES}\n` }));
  expect(on).toBe(RULES);

  expect(buildWorkerInitialContext({ ...worker, toolReviewRules: on })).toContain(SECTION);
  expect(buildManagerInitialContext({ managerDir: "/data/manager", toolReviewRules: on })).toContain(SECTION);
  expect(buildWorkerInitialContext({ ...worker, toolReviewRules: "" })).not.toContain("## Your user's rules for risky steps");
  expect(buildManagerInitialContext({ managerDir: "/data/manager" })).not.toContain("## Your user's rules for risky steps");
});
