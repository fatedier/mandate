import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { ChatInput } from "@/routes/window/chat/ChatInput";
import { useManagerThreadsStore } from "@/store/manager-threads";
import type { CanvasMentionDto } from "@shared/api/canvas";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle, settleUntil, typeInto } from "../helpers/mount.js";
import { managerThreadDto } from "../helpers/client-builders.js";

// Typed as pinyin after @, Chinese titles answer: full pinyin, initials, or
// the two mixed. Titles holding the letters come first. The characters that
// answered are marked, in threads and canvases alike. While an input method
// composes, the letters it shows, with its separators, are what is matched.

afterEach(() => {
  runCleanups();
  act(() => useManagerThreadsStore.setState({ threads: new Map(), archived: [] }));
});

const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 10, minute)).toISOString();
const THREADS = [
  managerThreadDto("thr_release", { title: "发布 3.21 版本", createdAt: at(50), lastActivityAt: at(50) }),
  managerThreadDto("thr_pack", { title: "打包脚本修复", createdAt: at(40), lastActivityAt: at(40) }),
  managerThreadDto("thr_db", { title: "DB 迁移", createdAt: at(10), lastActivityAt: at(10) }),
  managerThreadDto("thr_opal", { title: "Opal 发布流程", createdAt: at(5), lastActivityAt: at(5) })
];
const CANVAS: CanvasMentionDto = { id: "cnv_check000001", title: "发布前检查报告", kind: "report", updatedAt: at(30), origin: null };

async function composer() {
  act(() => useManagerThreadsStore.setState({ threads: new Map(THREADS.map((t) => [t.id, t])), archived: [] }));
  // The server's search is its own (canvas-routes): here it answers with one canvas for any letters.
  mockFetch((call) => {
    const q = new URL(call.url, "http://x").searchParams.get("q") ?? "";
    return jsonResponse(q === "" ? { canvases: [], total: 0 } : { canvases: [CANVAS], total: 1 });
  });
  const original = globalThis.getComputedStyle;
  onCleanup(() => { globalThis.getComputedStyle = original; });
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  const { host } = await mountAsync(<MemoryRouter><ChatInput onSend={() => {}} mentions={{ excludeId: null }} /></MemoryRouter>);
  const textarea = () => host.getElementsByTagName("textarea")[0]!;
  const type = async (text: string) => { await typeInto(textarea(), text, text.length, text.length); await settle(); };
  /** Each row: its title, with the characters that answered in [brackets]. */
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="mention-list"] [data-slot="mention-title"]')].map((title) =>
    [...title.childNodes].map((node) => (node instanceof window.HTMLElement && node.dataset.slot === "mention-mark" ? `[${node.textContent}]` : node.textContent)).join(""));
  // The pinyin is loaded with the first @: wait for it to answer.
  const ready = async () => { await type("@fb"); await settleUntil(() => rows().length > 0, "pinyin to load"); };
  return { textarea, type, rows, ready };
}

test("pinyin finds Chinese titles: full, initials, mixed; those holding the letters first; what answered is marked", async () => {
  const c = await composer();
  await c.ready();
  expect(c.rows()).toEqual(["[发布] 3.21 版本", "Opal [发布]流程", "[发布]前检查报告"]);
  await c.type("@fabu");
  expect(c.rows()).toEqual(["[发布] 3.21 版本", "Opal [发布]流程", "[发布]前检查报告"]);
  await c.type("@fabub");
  expect(c.rows().slice(0, 1)).toEqual(["[发布] 3.21 [版]本"]);
  // DB 迁移 holds "db"; 打包脚本修复 answers it as da bao, though newer.
  await c.type("@db");
  expect(c.rows().slice(0, 2)).toEqual(["[DB] 迁移", "[打包]脚本修复"]);
});

test("while an input method composes, the letters it shows, separators and all, find titles; typed so by hand they do not", async () => {
  const c = await composer();
  await c.ready();
  // The input method begins right after the @.
  await c.type("@");
  act(() => { c.textarea().dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true })); });
  await c.type("@fa bu");
  expect(c.rows()).toEqual(["[发布] 3.21 版本", "Opal [发布]流程", "[发布]前检查报告"]);
  await c.type("@fa'bu");
  expect(c.rows()[0]).toBe("[发布] 3.21 版本");
  act(() => { c.textarea().dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" })); });
  await settle();
  await c.type("@fa bu");
  expect(c.rows()).toEqual([]);
});

test("letters composed after a picked mention and its space open no list", async () => {
  const c = await composer();
  await c.ready();
  await c.type("@Opal");
  expect(c.rows()[0]).toBe("[Opal] 发布流程");
  act(() => { c.textarea().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await settleUntil(() => c.textarea().value === "@Opal 发布流程 ", "the pick written");
  expect(c.rows()).toEqual([]);
  // The input method begins after the space the pick wrote, and shows "fa bu".
  const end = c.textarea().value.length;
  act(() => {
    c.textarea().setSelectionRange(end, end);
    c.textarea().dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
  });
  await c.type("@Opal 发布流程 fa bu");
  expect(c.rows()).toEqual([]);
  // A new @ among those letters is a query of its own, composing or not.
  await c.type("@Opal 发布流程 @fa bu");
  expect(c.rows()[0]).toBe("[发布] 3.21 版本");
});
