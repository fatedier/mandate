import { expect, test } from "bun:test";
import { latestReasoningHeading } from "../src/shared/reasoning-heading.js";

test("the heading is the newest line that opens with a bolded phrase", () => {
  expect(latestReasoningHeading("")).toBe(null);
  expect(latestReasoningHeading("I need what merged since 3.21.")).toBe(null);
  expect(latestReasoningHeading("**Gathering merged changes**\n\nI need what merged.")).toBe("Gathering merged changes");
  expect(latestReasoningHeading("**Gathering**\n\nbody\n\n**Checking the changelog format**\n\nmore")).toBe("Checking the changelog format");
  // Markdown heading marks around it are dropped; text after the bold is not part of it.
  expect(latestReasoningHeading("## **Planning the release**")).toBe("Planning the release");
  expect(latestReasoningHeading("**Planning** the release")).toBe("Planning");
});

test("bold inside a sentence, or a heading still streaming, does not take over", () => {
  expect(latestReasoningHeading("**Gathering**\n\nUse **pnpm** here, not npm.")).toBe("Gathering");
  expect(latestReasoningHeading("**Gathering**\n\nbody\n\n**Checking the chan")).toBe("Gathering");
  expect(latestReasoningHeading("**   **\n\nbody")).toBe(null);
});
