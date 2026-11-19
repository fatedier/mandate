import { expect, test } from "bun:test";
import { contentSimilarity, SIMILAR_MEMORY_THRESHOLD } from "../src/server/modules/memory/content-similarity.js";

// The dream flags possible duplicates with this function and threshold,
// beside stored embeddings.

test("the same words in another case and punctuation score 1", () => {
  expect(contentSimilarity("The user prefers pnpm.", "the user PREFERS pnpm!")).toBe(1);
});

test("one memory inside another scores their length ratio", () => {
  expect(contentSimilarity("Use pnpm", "Use pnpm for every install")).toBeCloseTo(8 / 26, 6);
});

test("one word changed in a sentence is flagged, even when it changes the meaning; an unrelated memory is not", () => {
  expect(contentSimilarity("The user prefers pnpm over npm for installs.", "The user prefers pnpm over yarn for installs."))
    .toBeGreaterThanOrEqual(SIMILAR_MEMORY_THRESHOLD);
  expect(contentSimilarity("The user prefers pnpm.", "Builds go through the staging pipeline.")).toBeLessThan(0.1);
});

test("text without spaces between words compares by character pairs", () => {
  // As one token each, these would share nothing.
  expect(contentSimilarity("部署前先确认没有运行中的任务", "部署前要先确认没有运行中的任务")).toBeGreaterThan(0.5);
  expect(contentSimilarity("部署前先确认没有运行中的任务", "这个文件的开头要写清用途")).toBe(0);
});

test("empty text is similar to nothing", () => {
  expect(contentSimilarity("", "anything")).toBe(0);
  expect(contentSimilarity("!!!", "anything")).toBe(0);
});
