import { afterEach, expect, test } from "bun:test";
import { MemoryRouter } from "react-router";
import { MarkdownView } from "@/components/MarkdownView";
import { resetCanvasTitles } from "@/store/canvas-titles";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mount } from "../helpers/mount.js";

// What a link opens shows on it: a canvas (a report, a design) and a file
// open in the app, after a page or a file icon; a web page opens in the
// browser, a small arrow after it. A bare address an agent wrote into Chinese
// text ends where the address does, not at the next space.

afterEach(() => { runCleanups(); resetCanvasTitles(); });

function render(text: string, fromWeb = false): HTMLElement {
  mockFetch(() => jsonResponse({ canvases: [] }));
  return mount(<MemoryRouter initialEntries={["/threads/thr_a"]}><MarkdownView text={text} fromWeb={fromWeb} /></MemoryRouter>).host;
}
const kinds = (host: HTMLElement) => [...host.querySelectorAll("a")].map((a) => [
  a.textContent,
  a.querySelector('[data-slot="canvas-link-icon"]') ? "canvas" : a.querySelector('[data-slot="file-link-icon"]') ? "file" : "-",
  a.querySelector('[data-slot="external-link-icon"]') ? "web" : "-"
]);
const hrefs = (host: HTMLElement) => [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));

test("a canvas link, whatever its words, has a page icon; a file link a file icon; a web link an arrow; the app's own pages neither", () => {
  const host = render("See [Oven timer report](/canvas/cnv_Q1w2E3r4T5y), the log [verify.log](file:///tmp/verify.log), issue [#34](https://git.example.com/team/app/-/issues/34), thread [Release](/threads/thr_b).");
  expect(kinds(host)).toEqual([
    ["Oven timer report", "canvas", "-"],
    ["verify.log", "file", "-"],
    ["#34", "-", "web"],
    ["Release", "-", "-"]
  ]);
});

test("writing from the web marks none of its links: every one of them is the web's", () => {
  expect(kinds(render("See [the guide](https://example.com/guide) and https://example.com/faq.", true))).toEqual([
    ["the guide", "-", "-"],
    ["https://example.com/faq", "-", "-"]
  ]);
});

test("a bare address ends at Chinese punctuation, or at Chinese after the comma or bracket that ended it", () => {
  const host = render([
    "- pipeline：https://git.example.com/team/app/-/pipelines/12（success，ref `x`）",
    "- 见 https://example.com/a。然后",
    "- 实测 https://example.com/v1/books,匿名可读",
    "- 价格 https://example.com/docs/bread-prices(原文)",
    "- 词条 https://zh.example.org/wiki/中文 在这里",
    "- 条目 https://en.example.org/wiki/Mercury_(planet)，见上",
    "- 人名 https://ja.example.org/wiki/佐々木 の項",
    "- Docs at https://example.com/b, then more."
  ].join("\n"));
  expect(hrefs(host)).toEqual([
    "https://git.example.com/team/app/-/pipelines/12",
    "https://example.com/a",
    "https://example.com/v1/books",
    "https://example.com/docs/bread-prices",
    "https://zh.example.org/wiki/%E4%B8%AD%E6%96%87",
    "https://en.example.org/wiki/Mercury_(planet)",
    "https://ja.example.org/wiki/%E4%BD%90%E3%80%85%E6%9C%A8",
    "https://example.com/b"
  ]);
  // What followed the address stays the sentence's.
  expect([...host.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "pipeline：https://git.example.com/team/app/-/pipelines/12（success，ref x）",
    "见 https://example.com/a。然后",
    "实测 https://example.com/v1/books,匿名可读",
    "价格 https://example.com/docs/bread-prices(原文)",
    "词条 https://zh.example.org/wiki/中文 在这里",
    "条目 https://en.example.org/wiki/Mercury_(planet)，见上",
    "人名 https://ja.example.org/wiki/佐々木 の項",
    "Docs at https://example.com/b, then more."
  ]);
});

test("an address written as a link keeps all of it", () => {
  expect(hrefs(render("[完整地址](https://example.com/a。b) 和 <https://example.com/c，d>"))).toEqual([
    // As the parser writes any address it is given: encoded.
    "https://example.com/a%E3%80%82b",
    "https://example.com/c%EF%BC%8Cd"
  ]);
});
