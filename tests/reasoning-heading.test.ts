import { expect, test } from "bun:test";
import { ReasoningHeadings } from "../src/shared/reasoning-heading.js";

/** The heading a whole summary has reached, read in one piece. */
function latestReasoningHeading(text: string): string | null {
  const tracker = new ReasoningHeadings();
  tracker.add("whole", text);
  return tracker.latest();
}

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

test("headings worked out as the parts arrive are the ones the joined summary gives, delta by delta", () => {
  const pieces = ["**Che", "cking**", "\n", "\n\n", "text ", "**Plan**", "## **Head", "ing**", " more", "**", "Use **pnpm** here", "x"];
  let seed = 7;
  const next = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 200; round++) {
    const tracker = new ReasoningHeadings();
    const parts = new Map<string, string>();
    for (let i = 0; i < 40; i++) {
      const id = `p${next(3)}`;
      const delta = pieces[next(pieces.length)]!;
      parts.set(id, (parts.get(id) ?? "") + delta);
      tracker.add(id, delta);
      const joined = [...parts.values()].filter((part) => part).join("\n\n");
      expect(tracker.latest()).toBe(latestReasoningHeading(joined));
    }
  }
});
