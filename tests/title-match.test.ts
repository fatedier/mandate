import { expect, test } from "bun:test";
import { match } from "pinyin-pro";
import { pinyinMatcher, titleHit } from "../src/shared/title-match.js";

// As the page and the server call it.
const pinyin = pinyinMatcher(match);

// What is typed after @ finds a title by its characters, or a Chinese title
// by its pinyin: full, initials, or the two mixed; either reading of a
// character that has two. A title holding the characters ranks before one
// found by pinyin. The characters that answered are marked.

test("a title holding what is typed answers first, any case; its characters are the marks", () => {
  expect(titleHit("DB 迁移", "db", pinyin)).toEqual({ rank: 0, marks: [0, 1] });
  expect(titleHit("页面 502 排查", "502", pinyin)).toEqual({ rank: 0, marks: [3, 4, 5] });
  expect(titleHit("anything", "", pinyin)).toEqual({ rank: 0, marks: [] });
});

test("a Chinese title answers its pinyin: full, initials, mixed, either reading; the input method's separators are dropped", () => {
  expect(titleHit("发布 3.21 版本", "fabu", pinyin)).toEqual({ rank: 1, marks: [0, 1] });
  expect(titleHit("发布 3.21 版本", "FB", pinyin)).toEqual({ rank: 1, marks: [0, 1] });
  expect(titleHit("发布前检查报告", "fbq", pinyin)).toEqual({ rank: 1, marks: [0, 1, 2] });
  expect(titleHit("发布前检查报告", "fabuq", pinyin)).toEqual({ rank: 1, marks: [0, 1, 2] });
  expect(titleHit("重庆火锅店", "cq", pinyin)?.marks).toEqual([0, 1]);
  expect(titleHit("重庆火锅店", "zq", pinyin)?.marks).toEqual([0, 1]);
  expect(titleHit("Opal 发布流程", "fa'bu", pinyin)).toEqual({ rank: 1, marks: [5, 6] });
  expect(titleHit("Opal 发布流程", "fa bu", pinyin)).toEqual({ rank: 1, marks: [5, 6] });
});

test("no pinyin for a title without Chinese, for what is not letters, or before the pinyin is loaded", () => {
  expect(titleHit("Fresh Bread", "fb", pinyin)).toBeNull();
  expect(titleHit("发布 3.21 版本", "发", pinyin)).toEqual({ rank: 0, marks: [0] });
  expect(titleHit("发布 3.21 版本", "!!", pinyin)).toBeNull();
  expect(titleHit("发布 3.21 版本", "fabu", null)).toBeNull();
});

test("ü is typed as v, as input methods take it", () => {
  expect(titleHit("过滤器修复", "guolv", pinyin)).toEqual({ rank: 1, marks: [0, 1] });
  expect(titleHit("效率优化", "xiaolv", pinyin)).toEqual({ rank: 1, marks: [0, 1] });
  expect(titleHit("效率优化", "xl", pinyin)).toEqual({ rank: 1, marks: [0, 1] });
});
