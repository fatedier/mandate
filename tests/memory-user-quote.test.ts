import { expect, test } from "bun:test";
import { normalizeQuoteText, quoteStatement } from "../src/server/modules/memory/user-quote.js";

const at = (text: string, when = "2026-10-07T00:00:00.000Z") => ({ text, at: when });

test("a quote is found in the user's words however its width, spacing and case differ", () => {
  const said = [at("One more thing: from now on run lint without that flag"), at("Keep  commit MESSAGES in English")];
  expect(quoteStatement("from now on run lint without that flag", said)).not.toBeNull();
  expect(quoteStatement("ｌｉｎｔ without that", said)).not.toBeNull(); // full-width letters (NFKC)
  expect(quoteStatement("keep commit messages in english", said)).not.toBeNull();
  expect(normalizeQuoteText("  A\n\tB  ")).toBe("a b");
});

test("words the user did not write, or fewer than four characters, are not a quote", () => {
  const said = [at("Ok, go with that")];
  expect(quoteStatement("go with that plan then", said)).toBeNull();
  expect(quoteStatement("ok", said)).toBeNull();
  expect(quoteStatement("   ", said)).toBeNull();
});

test("a quote said more than once is dated by the latest time", () => {
  const said = [at("tag from master", "2026-09-02T00:00:00.000Z"), at("tag from master", "2026-09-05T00:00:00.000Z"), at("something else", "2026-09-09T00:00:00.000Z")];
  expect(quoteStatement("tag from master", said)?.at).toBe("2026-09-05T00:00:00.000Z");
});
