import { expect, test } from "bun:test";
import { unusedSkillsArchivedNotice } from "../src/server/modules/skills/learned-skill-notices.js";

test("the 60-day rule's day is one notice: how many it archived, which ones, linked to the Skills view", () => {
  const one = unusedSkillsArchivedNotice([{ id: "lsk_a", name: "release-steps" }], "2026-11-17");
  expect([one.title, one.text, one.level, one.matter?.link]).toEqual(["1 unused skill archived", "release-steps", "news", "/memory?view=skills"]);
  const two = unusedSkillsArchivedNotice([{ id: "lsk_a", name: "release-steps" }, { id: "lsk_b", name: "recon-steps" }], "2026-11-17");
  expect([two.title, two.text]).toEqual(["2 unused skills archived", "release-steps, recon-steps"]);
  expect(two.matter?.key).toBe("skills-unused:2026-11-17");
});
