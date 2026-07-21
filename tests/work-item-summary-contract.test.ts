import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildWorkerSystemPrompt,
  buildManagerSystemPrompt,
  _clearTemplateCache
} from "../src/server/modules/agent/system-prompt.js";
import { buildFeatureWorkItemTool } from "../src/server/modules/agent/tools/feature-work-item-tools.js";
import { buildWorkItemTools } from "../src/server/modules/agent/tools/work-item-tools.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";

/**
 * Three fields in this codebase are called "summary". These assertions pin the
 * one boundary that keeps costing us: the work item summary (S1) is written
 * for the user, and the feature digest (S3) is the handoff to the manager. Every
 * surface that tells an agent what to write must say which of the two it is.
 *
 * Asserted per surface — the tool description and the system prompt reach the
 * model through different channels, and a claim satisfied by one of them says
 * nothing about the other.
 */

/** Prompts are hard-wrapped markdown; a phrase that reads as one sentence can
 *  straddle a newline. Assert against the flattened text so the tests pin the
 *  wording rather than the wrap column. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

function stores() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  const sse = { emit: () => {} } as never;
  return { workStore: new WorkItemStore(db), sse };
}

test("update_my_work_item tells the model the summary is for the user, not for agents", () => {
  const { workStore, sse } = stores();
  const description = flat(buildFeatureWorkItemTool({
    workStore, sse, resolveFeatureId: () => "f1"
  }).description);

  expect(description).toContain("written FOR THE USER");
  expect(description).toContain("NOT shared state between agents");
  expect(description).toContain("update_feature_digest for the manager handoff");
  expect(description).toContain("at most 3 short lines");
  // and that it must not simply restate what the pane already shows
  expect(description).toContain("NOT a restatement of phase or phaseDetail");
});

test("update_work_item tells the manager the same field is the user's, and is attributed", () => {
  const { workStore, sse } = stores();
  const description = flat(buildWorkItemTools({ workStore, sse })[0]!.description);

  expect(description).toContain("the user's short read on where the feature stands");
  expect(description).toContain("hand off through their feature digest");
  expect(description).toContain("recorded as yours");
  expect(description).toContain("Do not set phase/phaseDetail");
});

test("the worker system prompt separates the user summary from the manager handoff", () => {
  _clearTemplateCache();
  const prompt = flat(buildWorkerSystemPrompt());

  expect(prompt).toContain("`summary` is what the user reads");
  expect(prompt).toContain("it is **not** shared state, and no agent reads it");
  expect(prompt).toContain("To hand state to **the manager**");
  expect(prompt).toContain("use `update_feature_digest`. That is the cross-agent channel");
  // The old wording asked for "3-5 tight bullet points" while another section
  // asked for "a one-line digest" — one instruction, one length.
  expect(prompt).not.toContain("3-5 tight bullet points");
  expect(prompt).not.toContain("one-line digest");
  expect(prompt).toContain("at most 3 short lines");
});

test("the manager system prompt says the work item summary is not a channel to other agents", () => {
  const prompt = flat(buildManagerSystemPrompt());

  expect(prompt).toContain("It is not shared state and no agent reads it back");
  expect(prompt).toContain("does so through its feature digest");
  expect(prompt).toContain("at most 3 lines, written for a person");
  expect(prompt).toContain("Your rewrite is stored as yours");
});
