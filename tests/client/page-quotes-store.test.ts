import { afterEach, expect, test } from "bun:test";
import { usePageQuotes } from "@/store/page-quotes";

afterEach(() => { usePageQuotes.setState({ byKey: new Map() }); });

const KEY = "personal:thr_g";
const q = (text: string) => ({ path: "index.html", text });
const quotes = (key = KEY) => usePageQuotes.getState().byKey.get(key) ?? [];

test("a composer holds up to 3 quotes, the same one once", () => {
  const { add } = usePageQuotes.getState();
  expect([add(KEY, q("a")), add(KEY, q("b")), add(KEY, q("a"))]).toEqual([true, true, true]);
  expect(quotes()).toEqual([q("a"), q("b")]);
  expect([add(KEY, q("c")), add(KEY, q("d"))]).toEqual([true, false]);
  expect(quotes()).toEqual([q("a"), q("b"), q("c")]);
  // The same words on another page are another quote; another composer has its own.
  expect(add("personal:thr_other", q("a"))).toBe(true);
  expect(quotes("personal:thr_other")).toEqual([q("a")]);
});

test("a quote taken out goes; a send lets go of what it sent and keeps one added meanwhile", () => {
  const { add, remove, sent } = usePageQuotes.getState();
  add(KEY, q("a"));
  add(KEY, q("b"));
  remove(KEY, q("a"));
  expect(quotes()).toEqual([q("b")]);
  const sending = quotes();
  add(KEY, q("c"));
  sent(KEY, sending);
  expect(quotes()).toEqual([q("c")]);
  sent(KEY, [q("c")]);
  expect(usePageQuotes.getState().byKey.has(KEY)).toBe(false);
});
