import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildWordsQuery, wordKeyBounds, wordsOf } from "../src/server/modules/agent/history-words.js";

// Chat history search reads Chinese by word: unicode61 keeps a run of Han
// characters as one token, so a word inside a clause would be found only when
// it begins the run.

test("a run of Han characters is split into words; other text is left as it is", () => {
  expect(wordsOf("我们讨论了数据库迁移的方案").trim().split(/\s+/)).toEqual(["我们", "讨论", "了", "数据", "库", "迁移", "的", "方案"]);
  expect(wordsOf("rollout plan v2 is ready")).toBe("rollout plan v2 is ready");
  // Joined to Latin letters, the words still stand apart from them.
  expect(wordsOf("数据库migration").trim().split(/\s+/)).toEqual(["数据", "库", "migration"]);
  // Japanese kana runs are split too.
  expect(wordsOf("データベースを移行する").trim().split(/\s+/).length).toBeGreaterThan(1);
});

test("a query's Chinese term is searched as its words in order; another term by its start", () => {
  expect(buildWordsQuery("数据库")).toBe('"数据 库"*');
  expect(buildWordsQuery("rollout 数据库迁移")).toBe('"rollout"* OR "数据 库 迁移"*');
  expect(buildWordsQuery("迁移")).toBe('"迁移"*');
  // Quotes and punctuation never reach the FTS syntax.
  expect(buildWordsQuery('say "hi" -->')).toBe('"say"* OR "hi"*');
  expect(buildWordsQuery("-->")).toBe("");
  // At most 12 terms, as before.
  expect(buildWordsQuery(Array.from({ length: 15 }, (_, k) => `t${k}`).join(" ")).split(" OR ")).toHaveLength(12);
});

test("a time range becomes rowid bounds: whole seconds, the end second included", () => {
  const second = Date.parse("2026-10-26T10:00:00.000Z") / 1000;
  expect(wordKeyBounds({ since: "2026-10-26T10:00:00.900Z", until: "2026-10-26T10:00:05.100Z" })).toEqual([second * 2 ** 20, (second + 5) * 2 ** 20 + 2 ** 20 - 1]);
  expect(wordKeyBounds({ since: null, until: null })).toEqual([0, Number.MAX_SAFE_INTEGER]);
  expect(Number.isSafeInteger(wordKeyBounds({ since: "2200-01-01T00:00:00.000Z", until: null })[0])).toBe(true);
});

// A term spelled like an FTS5 operator would make the whole query invalid,
// and search would fall back to unranked text matching.
test("a term spelled like an FTS operator is a word: the query stays valid and finds it", () => {
  const db = new Database(":memory:");
  db.exec("create virtual table t using fts5(body, tokenize='unicode61')");
  db.prepare("insert into t (body) values (?)").run("keep OR drop the NEAR cache AND NOT the plan");
  for (const query of ["keep OR drop", "NEAR cache", "AND", "NOT plan", "OR"]) {
    expect([query, (db.prepare("select count(*) as n from t where t match ?").get(buildWordsQuery(query)) as { n: number }).n]).toEqual([query, 1]);
  }
});
