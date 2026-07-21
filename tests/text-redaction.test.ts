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
