import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ToolRun } from "@/routes/window/chat/ToolRun";
import { ToolCallDetails } from "@/routes/window/chat/ToolCallDetails";
import { callNote, describeCall, type ToolRunRow } from "@/routes/window/chat/tool-run-summary";
import { formatFetchText, formatSearchText, WEB_TEXT_SENTENCE } from "@shared/web-tool-text";
import { fakePhoneWidth } from "../fake-phone-width";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

afterEach(() => {
  runCleanups();
  document.body.innerHTML = "";
});

const ID = "0123456789abcdef";
const START = "2026-08-02T10:04:00.000Z";
const call = (toolName: string, args: unknown, result: ToolRunRow["result"]): ToolRunRow =>
  ({ call: { toolCallId: `${toolName}-1`, toolName, args }, result, isRunning: false, startedAt: START });
const said = (row: ToolRunRow) => { const p = describeCall(row); return [p.lead, p.detail, p.detailIsCode ? "code" : "text"]; };
const headings = (el: ParentNode) => [...el.querySelectorAll('[data-slot="detail-label"]')].map((h) => h.textContent);
function section(el: ParentNode, label: string): HTMLElement {
  const heading = [...el.querySelectorAll('[data-slot="detail-label"]')].find((h) => h.textContent === label);
  if (!heading) throw new Error(`no section "${label}" in ${headings(el).join(", ")}`);
  return heading.parentElement!.parentElement!;
}
const details = (row: ToolRunRow) => mount(<ToolCallDetails row={row} />).host;

const searchText = formatSearchText({ answer: "Kettles boil at **100**.", backend: "Tavily", ms: 1200, id: ID, results: [
  { title: "Kettle facts", url: "https://tea.test/facts", excerpt: "Water boils", site: "Tea" },
  { title: "More", url: "https://tea.test/more", excerpt: "x" }
] });
const pageText = formatFetchText({ finalUrl: "https://tea.test/a", length: 48213, start: 0, end: 16000, cut: false, title: "Kettle Notes", author: "Ada", published: "2026-02-03", site: "Tea", window: "# Kettle Notes\n\nBoil." }, ID);

test("a search row says what was searched and how many results", () => {
  const row = call("web_search", { query: "kettle boiling point" }, { result: searchText });
  expect(said(row)).toEqual(["Searched the web for", "kettle boiling point", "text"]);
  expect(callNote(row)).toBe("2 results");
  expect(callNote(call("web_search", { query: "q" }, { result: formatSearchText({ results: [{ title: "a", url: "https://a.test", excerpt: "" }], backend: "Exa", ms: 1, id: ID }) }))).toBe("1 result");
  expect(callNote(call("web_search", { query: "q" }, { result: "The search found nothing for this query." }))).toBe("0 results");
  expect(callNote(call("web_search", { query: "q" }, { isError: true, error: "Web search failed (Exa): 401." }))).toBeNull();
});

test("a page row says the host and path, and how much was read", () => {
  const row = call("web_fetch", { url: "https://tea.test/a?b=1" }, { result: pageText });
  expect(said(row)).toEqual(["Fetched", "tea.test/a?b=1", "code"]);
  expect(callNote(row)).toBe("16,000 of 48,213 chars");
  const whole = formatFetchText({ finalUrl: "https://tea.test/b", length: 682, start: 0, end: 682, cut: false, window: "w" }, ID);
  expect(callNote(call("web_fetch", { url: "https://tea.test/b" }, { result: whole }))).toBe("682 chars");
  const last = formatFetchText({ finalUrl: "https://tea.test/a", length: 48213, start: 16000, end: 48213, cut: false, window: "w" }, ID);
  expect(callNote(call("web_fetch", { url: "https://tea.test/a", offset: 16000 }, { result: last }))).toBe("32,213 of 48,213 chars");
  expect(callNote(call("web_fetch", { url: "https://tea.test/b" }, { result: "shortened by retention" }))).toBeNull();
});

test("a search opens on the answer, the results as links and who found them, with no markers", () => {
  const el = details(call("web_search", { query: "q" }, { result: searchText }));
  expect(headings(el)).toEqual(["Answer", "Results"]);
  expect(el.textContent).not.toContain("WEB_TEXT");
  expect(section(el, "Answer").querySelector("strong")?.textContent).toBe("100");
  const links = [...section(el, "Results").querySelectorAll("a")];
  expect(links.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")])).toEqual([
    ["Kettle facts", "https://tea.test/facts", "_blank", "noopener noreferrer"],
    ["More", "https://tea.test/more", "_blank", "noopener noreferrer"]
  ]);
  expect(section(el, "Results").textContent).toContain("tea.test · Tea · Water boils");
  expect(el.querySelector('[data-slot="web-search-found-by"]')?.textContent).toBe("Found by Tavily in 1.2 s");
});

test("an answer that named no pages opens on the answer and who found it, with no empty Results", () => {
  const answerOnly = formatSearchText({ answer: "Python **3.15.0** is the latest.", backend: "Model search · p/m1", ms: 4500, id: ID, results: [] });
  const el = details(call("web_search", { query: "q" }, { result: answerOnly }));
  expect(headings(el)).toEqual(["Answer"]);
  expect(section(el, "Answer").querySelector("strong")?.textContent).toBe("3.15.0");
  expect(el.querySelector('[data-slot="web-search-found-by"]')?.textContent).toBe("Found by Model search · p/m1 in 4.5 s");
  // An answer with no pages is not nothing: its note says so.
  expect(callNote(call("web_search", { query: "q" }, { result: answerOnly }))).toBe("answer only");
});

test("nothing found shows its own line", () => {
  const el = details(call("web_search", { query: "q" }, { result: "The search found nothing for this query." }));
  expect(el.textContent).toContain("The search found nothing for this query.");
});

test("a page opens on its fields and the text shown, with no markers or sentence", () => {
  const el = details(call("web_fetch", { url: "https://tea.test/a" }, { result: pageText }));
  expect(headings(el)).toEqual(["Page", "Text shown"]);
  const page = section(el, "Page");
  expect([...page.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["Title", "Author", "Published", "Site", "Address", "Shown"]);
  expect([...page.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual(["Kettle Notes", "Ada", "2026-02-03", "Tea", "https://tea.test/a", "characters 0–16,000 of 48,213 · read on from 16,000"]);
  expect(page.querySelector("a")?.getAttribute("href")).toBe("https://tea.test/a");
  // The text is Markdown, drawn as such (a top heading is the chat's h3).
  expect(section(el, "Text shown").querySelector("h3")?.textContent).toBe("Kettle Notes");
  expect(section(el, "Text shown").textContent).not.toContain("# Kettle Notes");
  expect(el.textContent).not.toContain("WEB_TEXT");
  expect(el.textContent).not.toContain(WEB_TEXT_SENTENCE);
  const whole = formatFetchText({ finalUrl: "https://tea.test/b", length: 682, start: 0, end: 682, cut: false, window: "w" }, ID);
  const wholeEl = details(call("web_fetch", { url: "https://tea.test/b" }, { result: whole }));
  expect([...section(wholeEl, "Page").querySelectorAll("dd")].at(-1)?.textContent).toBe("all 682 characters");
  expect(wholeEl.querySelector('[data-slot="web-fetch-cut"]') === null).toBe(true);
  const last = formatFetchText({ finalUrl: "https://tea.test/a", length: 48213, start: 16000, end: 48213, cut: true, window: "w" }, ID);
  const lastEl = details(call("web_fetch", { url: "https://tea.test/a", offset: 16000 }, { result: last }));
  expect([...section(lastEl, "Page").querySelectorAll("dd")].at(-1)?.textContent).toBe("characters 16,000–48,213 of 48,213");
  expect(lastEl.querySelector('[data-slot="web-fetch-cut"]')?.textContent).toBe("Only the first 5 MB of the page were read.");
});

test("an image in web text is a link to it, never loaded", () => {
  const withImage = formatFetchText({ finalUrl: "https://tea.test/a", length: 60, start: 0, end: 60, cut: false, window: "Look: ![A kettle](https://tea.test/k.png) and ![](https://tea.test/bare.png)" }, ID);
  const el = details(call("web_fetch", { url: "https://tea.test/a" }, { result: withImage }));
  expect(el.querySelector("img") === null).toBe(true);
  expect([...section(el, "Text shown").querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
    ["A kettle", "https://tea.test/k.png"],
    ["https://tea.test/bare.png", "https://tea.test/bare.png"]
  ]);
  const answer = formatSearchText({ answer: "See ![a chart](https://tea.test/c.png).", backend: "Exa", ms: 1, id: ID, results: [{ title: "T", url: "https://tea.test/t", excerpt: "e" }] });
  const searchEl = details(call("web_search", { query: "q" }, { result: answer }));
  expect(searchEl.querySelector("img") === null).toBe(true);
  expect(section(searchEl, "Answer").querySelector("a")?.getAttribute("href")).toBe("https://tea.test/c.png");
});

test("an address that is no http(s) link stays text", () => {
  const text = formatSearchText({ backend: "Exa", ms: 1, id: ID, results: [{ title: "Odd", url: "javascript:alert(1)", excerpt: "e" }] });
  const el = details(call("web_search", { query: "q" }, { result: text }));
  expect(section(el, "Results").querySelector("a") === null).toBe(true);
  expect(section(el, "Results").textContent).toContain("Odd");
});

test("a failure shows its error; a shape the views do not know falls back to the generic view", () => {
  const failed = details(call("web_search", { query: "q" }, { isError: true, error: "Web search failed (Exa): 401 Unauthorized." }));
  expect(failed.textContent).toContain("Web search failed (Exa): 401 Unauthorized.");
  const odd = details(call("web_search", { query: "q", extra: 1 }, { result: searchText }));
  expect(headings(odd)).not.toContain("Answer");
  const garbled = details(call("web_fetch", { url: "https://tea.test/a" }, { result: "garbled" }));
  expect(headings(garbled)).not.toContain("Page");
  const refused = details(call("web_fetch", { url: "https://tea.test/a" }, { isError: true, error: "The page answered 404 Not Found." }));
  expect(headings(refused)).toEqual(["Error"]);
  expect(refused.textContent).toContain("The page answered 404 Not Found.");
  const oddPage = details(call("web_fetch", { url: "https://tea.test/a", extra: 1 }, { result: pageText }));
  expect(headings(oddPage)).not.toContain("Page");
});

test("the note is drawn on the run line, in the call list and in the phone sheet", async () => {
  const search = call("web_search", { query: "kettle" }, { result: searchText, createdAt: "2026-08-02T10:04:00.300Z" });
  const single = mount(<ToolRun rows={[search]} />).host;
  expect(single.querySelector('[data-slot="tool-run-line"]')!.textContent).toContain("· 2 results");
  const page = { ...call("web_fetch", { url: "https://tea.test/a" }, { result: pageText, createdAt: "2026-08-02T10:04:00.400Z" }), call: { toolCallId: "f2", toolName: "web_fetch", args: { url: "https://tea.test/a" } } };
  const two = mount(<ToolRun rows={[search, page]} expandedIds={new Set([`run:${search.call.toolCallId}`])} />).host;
  const notes = [...two.querySelectorAll('[data-slot="tool-call"] [data-slot="tool-call-note"]')].map((n) => n.textContent);
  expect(notes).toEqual(["· 2 results", "· 16,000 of 48,213 chars"]);
  onCleanup(fakePhoneWidth(390));
  const phone = mount(<ToolRun rows={[search]} />).host;
  await act(async () => { (phone.querySelector('[data-slot="tool-run-line"]') as HTMLElement).click(); });
  expect(document.querySelector('[role="dialog"] [data-slot="tool-sheet-status"]')!.textContent).toContain("2 results");
  const list = mount(<ToolRun rows={[search, page]} />).host;
  await act(async () => { (list.querySelector('[data-slot="tool-run-line"]') as HTMLElement).click(); });
  const sheet = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
  expect([...sheet.querySelectorAll('[data-slot="tool-call"] [data-slot="tool-call-note"]')].map((n) => n.textContent))
    .toEqual(["· 2 results", "· 16,000 of 48,213 chars"]);
});
