import { describe, expect, test } from "bun:test";
import {
  buildDreamAgentSystemPrompt,
  buildDreamTaskPrompt
} from "../src/server/modules/memory/dream.js";

const BUDGET = 12;
const frp = { kind: "project", projectId: "proj_frp" } as const;
const mandate = { kind: "project", projectId: "proj_mandate" } as const;
const global = { kind: "global" } as const;

/** The longest prefix two strings share, in characters. */
function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Providers cache on an exact prompt prefix. The dream was getting 32% cache
 * reads against 93% on the agent path, same provider, because every run opened
 * with `Dream run: ${runId}` — a unique first line that invalidated the whole
 * conversation behind it — and because the partition rules sat in the middle of
 * the system prompt rather than at its end.
 */
describe("dream prompt prefix stability", () => {
  test("the opening message is identical for every run", () => {
    // It carried the run id before, so no two runs could share a cache entry.
    expect(buildDreamTaskPrompt()).toBe(buildDreamTaskPrompt());
    expect(buildDreamTaskPrompt()).not.toMatch(/drm_|run id|Dream run/i);
  });

  test("two runs over the same partition produce byte-identical prompts", () => {
    expect(buildDreamAgentSystemPrompt(BUDGET, frp)).toBe(
      buildDreamAgentSystemPrompt(BUDGET, frp)
    );
  });

  test("different partitions share everything except the tail", () => {
    const a = buildDreamAgentSystemPrompt(BUDGET, frp);
    const b = buildDreamAgentSystemPrompt(BUDGET, mandate);
    const shared = sharedPrefix(a, b);
    // The partition rules are the only divergence, and they are short.
    expect(shared / Math.min(a.length, b.length)).toBeGreaterThan(0.9);
  });

  test("project and global partitions still share the whole body", () => {
    const a = buildDreamAgentSystemPrompt(BUDGET, frp);
    const b = buildDreamAgentSystemPrompt(BUDGET, global);
    expect(sharedPrefix(a, b) / Math.min(a.length, b.length)).toBeGreaterThan(0.9);
  });

  test("the divergence is the project id itself, nothing earlier", () => {
    // Two project runs share every instruction and even the opening of the
    // partition sentence; they part only where the id differs. That is the
    // most prefix two partitions can possibly share.
    const a = buildDreamAgentSystemPrompt(BUDGET, frp);
    const b = buildDreamAgentSystemPrompt(BUDGET, mandate);
    const prefix = a.slice(0, sharedPrefix(a, b));
    expect(prefix).not.toContain("proj_frp");
    expect(prefix).toContain("restricted to project proj_");
    // Everything after the divergence is one short sentence pair.
    expect(a.length - prefix.length).toBeLessThan(200);
  });

  test("the partition rule is still present — reordering must not drop it", () => {
    expect(buildDreamAgentSystemPrompt(BUDGET, frp)).toContain("proj_frp");
    expect(buildDreamAgentSystemPrompt(BUDGET, global)).toContain("user/global memories");
  });
});
