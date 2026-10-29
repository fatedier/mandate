import { expect, test } from "bun:test";
import { redactSecrets } from "../src/server/platform/text/text.js";

test("redactSecrets redacts quoted env api keys, short secrets, punctuated secrets, standalone sk tokens, and JSON secrets", () => {
  const text = `OPENAI_API_KEY="quotedStandaloneSecret123456"\nOTHER_API_KEY = 'otherStandaloneSecret123456'\npassword=hunter2\ntoken=p@ss!\nsecret="short"\nplain sk-standaloneSecret123456\n{"password":"jsonHunter2","token":"jsonP@ss!","OPENAI_API_KEY":"jsonApiKey123456","secret":"space secret","api_key":"escaped \\" secret"}`;
  const redacted = redactSecrets(text);

  expect(redacted).toContain("OPENAI_API_KEY=[REDACTED]");
  expect(redacted).toContain("OTHER_API_KEY = [REDACTED]");
  expect(redacted).toContain("password=[REDACTED]");
  expect(redacted).toContain("token=[REDACTED]");
  expect(redacted).toContain("secret=[REDACTED]");
  expect(redacted).toContain('"password":[REDACTED]');
  expect(redacted).toContain('"token":[REDACTED]');
  expect(redacted).toContain('"OPENAI_API_KEY":[REDACTED]');
  expect(redacted).toContain("plain [REDACTED]");
  expect(redacted).not.toContain("quotedStandaloneSecret");
  expect(redacted).not.toContain("otherStandaloneSecret");
  expect(redacted).not.toContain("hunter2");
  expect(redacted).not.toContain("p@ss!");
  expect(redacted).not.toContain("short");
  expect(redacted).not.toContain("sk-standaloneSecret");
  expect(redacted).not.toContain("jsonHunter2");
  expect(redacted).not.toContain("jsonP@ss!");
  expect(redacted).not.toContain("jsonApiKey");
  expect(redacted).not.toContain("space secret");
  expect(redacted).not.toContain("escaped");
});

// The API_KEY patterns used an unbounded `[A-Z0-9_]*` prefix, which (with /i)
// backtracks quadratically on a long run of word characters: 32KB took 1.5s.
test("redactSecrets is linear on a long run of word characters", () => {
  const started = performance.now();
  expect(redactSecrets("b".repeat(256_000))).toBe("b".repeat(256_000));
  // Linear takes tens of ms; the quadratic backtracking took 1.5 s on 32 KB,
  // so minutes on this. The bound leaves a busy machine room (300 ms did not).
  expect(performance.now() - started).toBeLessThan(3_000);
});

test("a very long env-var name before API_KEY is still redacted", () => {
  const name = `${"X".repeat(200)}_API_KEY`;
  const redacted = redactSecrets(`${name}=abcdef123456`);
  expect(redacted).not.toContain("abcdef123456");
  expect(redacted).toContain("[REDACTED]");
});

test("a quoted secret with an escaped line break in it is redacted whole", () => {
  for (const quote of ['"', "'", "`"]) {
    const out = redactSecrets(`token=${quote}first-half\\\nsecond-half${quote} after`);
    expect([quote, out]).toEqual([quote, "token=[REDACTED] after"]);
  }
});
