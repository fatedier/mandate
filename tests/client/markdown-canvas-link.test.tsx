import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, useLocation, type Location } from "react-router";
import { MarkdownView } from "@/components/MarkdownView";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount, settle, settleUntil } from "../helpers/mount.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { resetCanvasTitles } from "@/store/canvas-titles";

// A link to a canvas in what an agent wrote opened a new browser tab, like
// any other link, and left the conversation behind. The canvas's card in the
// same chat opens it over the page. The link does too now, and so does the
// canvas's path where the agent wrote it as code or bare in its text, which
// could not be clicked.

afterEach(() => { runCleanups(); resetCanvasTitles(); });

const HERE = "/threads/thr_a?worker=w1";
let at: Location | null = null;
function Where() {
  at = useLocation();
  return null;
}

function reply(text: string, props: { inline?: boolean; fromWeb?: boolean } = {}): HTMLElement {
  at = null;
  return mount(
    <MemoryRouter initialEntries={[HERE]}>
      <MarkdownView text={text} {...props} />
      <Where />
    </MemoryRouter>
  ).host;
}

/** A click as the browser sends it; whether the page kept it from the browser. */
function click(el: Element, init: MouseEventInit = {}): boolean {
  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => { el.dispatchEvent(event); });
  return event.defaultPrevented;
}
const where = () => `${at!.pathname}${at!.search}${at!.hash}`;
const behind = () => {
  const from = (at!.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  return from ? `${from.pathname}${from.search}` : null;
};

test("a link to a canvas opens it over the page it was on, and the browser does not open a tab", () => {
  const host = reply("The write-up is ready: [the release notes](/canvas/cnv_1).");
  const link = host.querySelector("a")!;
  expect(link.textContent).toBe("the release notes");
  expect(where()).toBe(HERE);
  expect(click(link)).toBe(true);
  expect(where()).toBe("/canvas/cnv_1");
  // The page it was opened from stays behind it: that is what makes it a layer.
  expect(behind()).toBe(HERE);
});

test("the same for a full address of this app, with what follows the id kept", () => {
  const host = reply(`See [the notes](${window.location.origin}/canvas/cnv_2?page=3#defaults).`);
  expect(click(host.querySelector("a")!)).toBe(true);
  expect(where()).toBe("/canvas/cnv_2?page=3#defaults");
  expect(behind()).toBe(HERE);
});

test("a click with a modifier key or another button is the browser's: it still opens a new tab", () => {
  const host = reply("[the release notes](/canvas/cnv_1)");
  const link = host.querySelector("a")!;
  // It is still a link to a new tab for the browser to follow.
  expect([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]).toEqual(["/canvas/cnv_1", "_blank", "noopener noreferrer"]);
  for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    expect([init, click(link, init)]).toEqual([init, false]);
    expect(where()).toBe(HERE);
  }
});

test("in the desktop app a canvas link opens over the page too, and is not handed to the system's browser", async () => {
  // What the desktop app is asked to open in the system's browser.
  const handed: Array<[string, string | undefined]> = [];
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (command: string, args?: { url?: string }) => { handed.push([command, args?.url]); }
  };
  onCleanup(() => { delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });
  // A full address is one the desktop app hands over, unless it is this
  // app's canvas.
  const host = reply(`[the notes](${window.location.origin}/canvas/cnv_1), [the defaults](/canvas/cnv_2) and [the docs](https://example.com/docs)`);
  const [notes, defaults, docs] = [...host.querySelectorAll("a")];
  expect(click(notes!)).toBe(true);
  expect([where(), behind()]).toEqual(["/canvas/cnv_1", HERE]);
  expect(click(defaults!)).toBe(true);
  expect(where()).toBe("/canvas/cnv_2");
  // The docs are handed over, after the two canvas links: they were not.
  expect(click(docs!)).toBe(true);
  expect(where()).toBe("/canvas/cnv_2");
  await settleUntil(() => handed.length > 0, "the docs link is handed to the system's browser");
  await settle(20);
  expect(handed).toStrictEqual([["plugin:opener|open_url", "https://example.com/docs"]]);
});

test("every other link is left to the browser", () => {
  const host = reply([
    "[docs](https://example.com/docs)", "[theirs](https://example.com/canvas/cnv_1)", "[embed](/canvas/cnv_1/embed)",
    "[a thread](/threads/thr_b)", "[relative](canvas/cnv_1)"
  ].join(" · "));
  const links = [...host.querySelectorAll("a")];
  expect(links).toHaveLength(5);
  for (const link of links) {
    expect([link.textContent, click(link)]).toEqual([link.textContent, false]);
    expect(where()).toBe(HERE);
  }
});

test("a canvas's path written as code is a link too, and opens the same way", () => {
  const host = reply("The defaults are at `/canvas/cnv_1`, not at `/canvas/cnv_1/embed`, the route `/canvas/:canvasId` or `serve --legacy`.");
  const codes = [...host.querySelectorAll("code")];
  expect(codes.map((code) => [code.textContent, code.closest("a")?.getAttribute("href") ?? null])).toEqual([
    ["/canvas/cnv_1", "/canvas/cnv_1"], ["/canvas/cnv_1/embed", null], ["/canvas/:canvasId", null], ["serve --legacy", null]
  ]);
  const link = codes[0]!.closest("a")!;
  // Still drawn as code, inside the link.
  expect(link.textContent).toBe("/canvas/cnv_1");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(click(codes[0]!, { metaKey: true })).toBe(false);
  expect(where()).toBe(HERE);
  expect(click(codes[0]!)).toBe(true);
  expect(where()).toBe("/canvas/cnv_1");
  expect(behind()).toBe(HERE);
});

test("code in a fence, and a link's own code, are not made links a second time", () => {
  const host = reply("```\n/canvas/cnv_1\n```\n\n[`/canvas/cnv_2`](/canvas/cnv_2)");
  // The fenced path is a block of code, not a link.
  expect(host.querySelector("pre a") === null).toBe(true);
  expect(host.querySelector("pre")!.textContent).toContain("/canvas/cnv_1");
  // The linked one is one link, not a link inside a link.
  const links = [...host.querySelectorAll("a")];
  expect(links.map((link) => [link.getAttribute("href"), link.querySelector("a") === null])).toEqual([["/canvas/cnv_2", true]]);
});

test("inside a row that is itself a button, a path is its words: no link is drawn there", () => {
  const host = reply("Kept at `/canvas/cnv_1`, see [the notes](/canvas/cnv_1).", { inline: true });
  expect(host.querySelector("a") === null).toBe(true);
  expect(host.querySelector("code")!.textContent).toBe("/canvas/cnv_1");
  expect(host.textContent).toBe("Kept at /canvas/cnv_1, see the notes.");
});

test("drawn outside a router, every link is a plain one and nothing breaks", () => {
  const host = mount(<MarkdownView text={"[the release notes](/canvas/cnv_1) and `/canvas/cnv_1`"} />).host;
  const links = [...host.querySelectorAll("a")];
  expect(links.map((link) => link.getAttribute("href"))).toEqual(["/canvas/cnv_1", "/canvas/cnv_1"]);
  for (const link of links) expect(click(link)).toBe(false);
});

// A canvas's id is `cnv_` and eleven letters, digits, `-` or `_`.
const ID = ["cnv_Q1w2E3r4T5y", "cnv_AbCd-12_EfG", "cnv_0123456789a", "cnv_zzzzzzzzzzz"] as const;

test("a canvas's path written bare in the text is a link too, and opens the same way", () => {
  const host = reply(`报告：/canvas/${ID[0]}\n\nDone (/canvas/${ID[1]}), see /canvas/${ID[2]}. 结论在 /canvas/${ID[3]}里`);
  const links = [...host.querySelectorAll("a")];
  expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual(ID.map((id) => [`/canvas/${id}`, `/canvas/${id}`]));
  // The words around it stay as they were.
  expect(host.textContent).toBe(`报告：/canvas/${ID[0]}\nDone (/canvas/${ID[1]}), see /canvas/${ID[2]}. 结论在 /canvas/${ID[3]}里`);
  expect(links[0]!.getAttribute("target")).toBe("_blank");
  expect(click(links[0]!, { metaKey: true })).toBe(false);
  expect(where()).toBe(HERE);
  expect(click(links[0]!)).toBe(true);
  expect(where()).toBe(`/canvas/${ID[0]}`);
  expect(behind()).toBe(HERE);
});

test("a bare path that is part of something longer, or names no canvas, stays text", () => {
  const id = ID[0];
  const host = reply([
    `/canvas/${id}/embed`, `~/canvas/${id}`, `./canvas/${id}`, `docs/canvas/${id}`, `localhost:4175/canvas/${id}`,
    `/canvas/${id}.md`, `x/canvas/${id}`, `/canvases/${id}`, `//canvas/${id}`,
    // Not a canvas's id: another word (one as long as an id's tail too), too short, too long.
    "/canvas/:canvasId", "/canvas/report", "/canvas/screenshots", "/canvas/cnv_1", `/canvas/${id}x`, "/canvas/cnv-Q1w2E3r4T5y"
  ].join(" · "));
  expect(host.querySelectorAll("a")).toHaveLength(0);
  // Another site's address is that site's link, as before.
  const theirs = reply(`at https://example.com/canvas/${id} now`);
  expect([...theirs.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([`https://example.com/canvas/${id}`]);
});

test("a bare path in a link's own words is not a link inside the link", () => {
  const host = reply(`[see /canvas/${ID[0]} first](/canvas/cnv_2)`);
  expect([...host.querySelectorAll("a")].map((link) => [link.getAttribute("href"), link.textContent])).toEqual([["/canvas/cnv_2", `see /canvas/${ID[0]} first`]]);
});

test("a bare path in a row that is itself a button, or in writing from the web, stays text", () => {
  expect(reply(`Kept at /canvas/${ID[0]}.`, { inline: true }).querySelector("a") === null).toBe(true);
  expect(reply(`Kept at /canvas/${ID[0]}.`, { fromWeb: true }).querySelector("a") === null).toBe(true);
});

// A path tells the reader nothing of the canvas: once its title is read, the
// path written bare or as code is drawn as the canvas's title instead.
test("a canvas's path, bare or as code, is drawn as the canvas's title once read; one read for all of a reply's paths", async () => {
  const asked: string[] = [];
  mockFetch((call) => {
    asked.push(new URL(call.url, "http://x").searchParams.get("ids") ?? "");
    return jsonResponse({ canvases: [{ id: ID[0], title: "Test Connection 带参数设计", kind: "design" }, { id: ID[1], title: "Release notes", kind: "report" }] });
  });
  const host = reply(`预览：/canvas/${ID[0]}，代码 \`/canvas/${ID[1]}\`，再提一次 /canvas/${ID[0]}`);
  // Until it is read, the path.
  expect([...host.querySelectorAll("a")].map((link) => link.textContent)).toEqual([`/canvas/${ID[0]}`, `/canvas/${ID[1]}`, `/canvas/${ID[0]}`]);
  await settleUntil(() => host.textContent?.includes("Release notes") ?? false, "the titles to be read");
  const links = [...host.querySelectorAll("a")];
  expect(links.map((link) => [link.textContent, link.getAttribute("href"), link.querySelector('[data-slot="canvas-title-icon"]') !== null])).toEqual([
    ["Test Connection 带参数设计", `/canvas/${ID[0]}`, true],
    ["Release notes", `/canvas/${ID[1]}`, true],
    ["Test Connection 带参数设计", `/canvas/${ID[0]}`, true]
  ]);
  expect(asked.map((ids) => ids.split(",").sort())).toStrictEqual([[ID[0], ID[1]].sort()]);
  // It opens as before.
  expect(click(links[0]!)).toBe(true);
  expect(where()).toBe(`/canvas/${ID[0]}`);
  // Drawn again, it is not read again.
  reply(`又是 /canvas/${ID[0]}`);
  await settle();
  expect(asked).toHaveLength(1);
});

test("a link the agent named keeps its words; a canvas that cannot be found, or an id no canvas has, keeps its path", async () => {
  const asked: string[] = [];
  mockFetch((call) => { asked.push(new URL(call.url, "http://x").searchParams.get("ids") ?? ""); return jsonResponse({ canvases: [] }); });
  // A path whose id is not shaped as a canvas's (the route described) is never asked about.
  const host = reply(`[the notes](/canvas/${ID[0]}) and /canvas/${ID[2]}, the route \`/canvas/cnv_1\``);
  await settleUntil(() => asked.length === 1, "the title asked for");
  await settle();
  expect([...host.querySelectorAll("a")].map((link) => link.textContent)).toEqual(["the notes", `/canvas/${ID[2]}`, "/canvas/cnv_1"]);
  expect(asked).toStrictEqual([ID[2]]);
});

test("a title that could not be read is asked for again when the reply draws again (as it streams)", async () => {
  let up = false;
  const calls = mockFetch(() => (up
    ? jsonResponse({ canvases: [{ id: ID[0], title: "Test Connection 带参数设计", kind: "design" }] })
    : jsonResponse({ error: "unavailable" }, 503)));
  at = null;
  const mounted = mount(<MemoryRouter initialEntries={[HERE]}><MarkdownView text={`预览：/canvas/${ID[0]}`} /><Where /></MemoryRouter>);
  await settleUntil(() => calls.length === 1, "the first read");
  await settle();
  expect(mounted.host.querySelector("a")!.textContent).toBe(`/canvas/${ID[0]}`);
  up = true;
  mounted.rerender(<MemoryRouter initialEntries={[HERE]}><MarkdownView text={`预览：/canvas/${ID[0]}，还在写`} /><Where /></MemoryRouter>);
  await settleUntil(() => mounted.host.textContent?.includes("Test Connection") ?? false, "the title read on the next draw");
  expect(calls.length).toBe(2);
});
