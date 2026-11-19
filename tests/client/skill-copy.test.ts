import { expect, test } from "bun:test";
import { skillAuthor } from "@/routes/memory/skills/skill-copy";

// Who wrote a revision, as a skill's History names them.
test("a revision the tidy wrote is authored 'Skill tidy'", () => {
  expect(skillAuthor({ by: "tidy", threadId: null, threadTitle: null, threadKind: null }, "Juno")).toBe("Skill tidy");
  expect(skillAuthor({ by: "review", threadId: "thr_w", threadTitle: "cert renewal", threadKind: "worker" }, "Juno")).toBe("Skill review of cert renewal");
});
