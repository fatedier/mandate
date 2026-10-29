import { expect, test } from "bun:test";
import { mentionQueryAt } from "@/routes/window/chat/mention-draft";

test("@ opens at the start, after a space, and after Chinese text, not inside an email", () => {
  expect(mentionQueryAt("@pa", 3)).toEqual({ start: 0, query: "pa" });
  expect(mentionQueryAt("ask @parser", 11)).toEqual({ start: 4, query: "parser" });
  expect(mentionQueryAt("跟进@parser", 9)).toEqual({ start: 2, query: "parser" });
  expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionQueryAt("me@x.com", 8)).toBe(null);
  expect(mentionQueryAt("v2@beta", 7)).toBe(null);
});

test("the query ends at the caret and holds no whitespace", () => {
  expect(mentionQueryAt("@parser errors", 7)).toEqual({ start: 0, query: "parser" });
  expect(mentionQueryAt("@parser errors", 14)).toBe(null);
  expect(mentionQueryAt("plain text", 10)).toBe(null);
  // The @ nearest the caret counts: an earlier mention is left as written.
  expect(mentionQueryAt("@General and @pa", 16)).toEqual({ start: 13, query: "pa" });
});
