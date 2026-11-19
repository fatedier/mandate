import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { FileView } from "@/routes/files/FileView";
import type { FileTarget } from "@/lib/file-link";
import { JSON_COLOR_MAX_CHARS } from "@/lib/json-format";
import type { FileDto } from "@shared/api-contracts";
import { mockFetch } from "../helpers/fetch.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settleUntil } from "../helpers/mount.js";

// The file an agent linked, as the page shows it: its name, folder, time and
// size; Markdown and HTML as they read or as source; JSON formatted or as
// source; text with numbered lines and the linked ones marked; a large text
// in parts; an image, a PDF, anything else; and each refusal in its fixed
// words.

afterEach(() => { runCleanups(); });

const TODAY = new Date();
TODAY.setHours(10, 42, 0, 0);

function dto(over: Partial<FileDto> = {}): FileDto {
  return {
    path: "/tmp/project-1/docs/report.md", name: "report.md", folder: "/tmp/project-1/docs",
    size: 3174, modifiedAt: TODAY.toISOString(), kind: "markdown", text: "# Cache expiry\n\nSee ![shot](shot.png) and [the plan](plan.md#L4).\n", ...over
  };
}

/** Serves one file (or a refusal) for every read, and records the reads. */
function serve(answer: (url: URL) => Response) {
  const reads: URL[] = [];
  mockFetch(({ url }) => {
    const parsed = new URL(url, "http://mandate.test");
    reads.push(parsed);
    return answer(parsed);
  });
  return reads;
}

async function render(target: FileTarget, opts: { onClose?: () => void } = {}) {
  const { host } = await mountAsync(
    <MemoryRouter><FileView target={target} presentation="panel" onClose={opts.onClose} /></MemoryRouter>
  );
  await settleUntil(() => host.querySelector('[data-slot="file-meta"], [data-slot="file-view"] h2, [data-slot="file-view"] [data-slot="state-message"]') !== null, "the file read");
  return host;
}

const text = (host: HTMLElement, slot: string) => host.querySelector(`[data-slot="${slot}"]`)?.textContent ?? null;
const button = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name) ?? null;
const press = async (el: Element | null) => {
  expect(el === null).toBe(false);
  await act(async () => { (el as HTMLElement).click(); });
};

test("the header names the file, its folder, when it changed and its size; a link's lines follow; Copy path copies it and says so itself, with no notice", async () => {
  serve(() => Response.json(dto()));
  const host = await render({ path: "/tmp/project-1/docs/report.md" });
  expect([text(host, "file-name"), text(host, "file-folder"), text(host, "file-meta")]).toEqual(["report.md", "/tmp/project-1/docs", "Modified 10:42 · 3.1 KB"]);
  const copied: string[] = [];
  const shown: string[] = [];
  const nav = navigator as unknown as { clipboard?: unknown };
  const before = Object.getOwnPropertyDescriptor(nav, "clipboard");
  const secure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  Object.defineProperty(nav, "clipboard", { configurable: true, value: { writeText: async (t: string) => { copied.push(t); } } });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  const original = toast.success;
  toast.success = ((message: unknown) => { shown.push(String(message)); return ""; }) as typeof toast.success;
  onCleanup(() => {
    toast.success = original;
    if (before) Object.defineProperty(nav, "clipboard", before);
    else delete nav.clipboard;
    if (secure) Object.defineProperty(window, "isSecureContext", secure);
    else delete (window as { isSecureContext?: boolean }).isSecureContext;
  });
  await press(button(host, "Copy path"));
  await settleUntil(() => button(host, "Copied") !== null, "the button saying Copied");
  expect([copied, shown]).toStrictEqual([["/tmp/project-1/docs/report.md"], []]);
});

// Copy path and Download sit after the file's name as icons, named on hover
// and to a screen reader, as on a phone.
test("Copy path and Download are icons, named on hover; in a browser Download saves the file under its own name", async () => {
  serve(() => Response.json(dto({ path: "/tmp/project-1/out/名单.csv", name: "名单.csv", folder: "/tmp/project-1/out", kind: "text", text: "id\n1\n" })));
  const host = await render({ path: "/tmp/project-1/out/名单.csv" });
  const copy = button(host, "Copy path")!;
  expect([copy.getAttribute("title"), copy.textContent]).toEqual(["Copy path", ""]);
  const download = host.querySelector<HTMLAnchorElement>('[data-slot="file-download"]')!;
  expect([download.tagName, download.getAttribute("aria-label"), download.getAttribute("title"), download.textContent, download.getAttribute("download")])
    .toEqual(["A", "Download", "Download", "", "名单.csv"]);
  const href = new URL(download.href);
  expect([href.pathname, href.searchParams.get("path")]).toEqual(["/api/files/download", "/tmp/project-1/out/名单.csv"]);
  // After Copy path.
  expect(copy.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a file it can't show can still be downloaded; one it could not open offers no download", async () => {
  serve(() => Response.json(dto({ path: "/tmp/model.xlsx", name: "model.xlsx", folder: "/tmp", kind: "other", text: undefined, size: 512 })));
  const other = await render({ path: "/tmp/model.xlsx" });
  expect(other.querySelector('[data-slot="file-download"]') !== null).toBe(true);
  runCleanups();
  serve(() => Response.json({ error: "x", code: "missing" }, { status: 404 }));
  const missing = await render({ path: "/tmp/gone.csv" });
  expect(missing.querySelector('[data-slot="file-download"]') === null).toBe(true);
});

// The desktop app's webview downloads nothing: the server puts a copy in
// Downloads, and the page says so.
test("in the desktop app Download puts a copy in Downloads and says so; a refusal says it couldn't save", async () => {
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  onCleanup(() => { delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });
  const said: string[] = [];
  const { success, error } = toast;
  toast.success = ((message: unknown) => { said.push(`ok: ${String(message)}`); return ""; }) as typeof toast.success;
  toast.error = ((message: unknown) => { said.push(`error: ${String(message)}`); return ""; }) as typeof toast.error;
  onCleanup(() => { toast.success = success; toast.error = error; });
  let refuse = false;
  const saves: unknown[] = [];
  mockFetch(({ url, init }) => {
    if (new URL(url, "http://mandate.test").pathname === "/api/files/save") {
      saves.push(JSON.parse(String(init!.body)));
      return refuse ? Response.json({ error: "x", code: "missing" }, { status: 404 }) : Response.json({ path: "/Users/you/Downloads/leaders.csv" });
    }
    return Response.json(dto({ path: "/tmp/project-1/leaders.csv", name: "leaders.csv", folder: "/tmp/project-1", kind: "text", text: "id\n" }));
  });
  const host = await render({ path: "/tmp/project-1/leaders.csv" });
  const download = host.querySelector<HTMLElement>('[data-slot="file-download"]')!;
  expect([download.tagName, download.getAttribute("aria-label"), download.getAttribute("title")]).toEqual(["BUTTON", "Download", "Download"]);
  await press(download);
  await settleUntil(() => said.length === 1, "the toast");
  refuse = true;
  await press(download);
  await settleUntil(() => said.length === 2, "the second toast");
  expect([saves, said]).toStrictEqual([[{ path: "/tmp/project-1/leaders.csv" }, { path: "/tmp/project-1/leaders.csv" }], ["ok: Saved to Downloads", "error: Couldn't save the file."]]);
});

test("lines in the meta line: one, or a range", async () => {
  serve(() => Response.json(dto({ path: "/tmp/a.ts", name: "a.ts", folder: "/tmp", kind: "text", text: "a\nb\nc\n" })));
  expect(text(await render({ path: "/tmp/a.ts", line: 2 }), "file-meta")).toBe("Modified 10:42 · 3.1 KB · Line 2");
  runCleanups();
  serve(() => Response.json(dto({ path: "/tmp/a.ts", name: "a.ts", folder: "/tmp", kind: "text", text: "a\nb\nc\n" })));
  expect(text(await render({ path: "/tmp/a.ts", line: 1, end: 3 }), "file-meta")).toBe("Modified 10:42 · 3.1 KB · Lines 1–3");
});

test("Markdown reads as it reads first; its relative picture loads from the server and its relative link is a file link; Source numbers its lines", async () => {
  serve(() => Response.json(dto()));
  const host = await render({ path: "/tmp/project-1/docs/report.md" });
  expect(text(host, "markdown")).toContain("Cache expiry");
  expect(host.querySelector('[data-slot="file-code"]') === null).toBe(true);
  const img = host.querySelector<HTMLImageElement>('[data-slot="markdown"] img')!;
  expect(new URL(img.getAttribute("src")!, "http://mandate.test").searchParams.get("path")).toBe("/tmp/project-1/docs/shot.png");
  expect(host.querySelector('[data-slot="markdown"] a[data-file-link]')!.getAttribute("data-file-link")).toBe("/tmp/project-1/docs/plan.md");
  expect(button(host, "Preview")!.getAttribute("aria-pressed")).toBe("true");
  await press(button(host, "Source"));
  expect(host.querySelector('[data-slot="markdown"]') === null).toBe(true);
  expect(text(host, "file-line-numbers")).toBe("1\n2\n3");
  expect(text(host, "file-text")).toBe("# Cache expiry\n\nSee ![shot](shot.png) and [the plan](plan.md#L4).");
});

test("a link that names lines opens Markdown on Source, the lines marked and in view", async () => {
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  serve(() => Response.json(dto({ text: lines })));
  const host = await render({ path: "/tmp/project-1/docs/report.md", line: 42, end: 44 });
  expect(button(host, "Source")!.getAttribute("aria-pressed")).toBe("true");
  const mark = host.querySelector<HTMLElement>('[data-slot="file-highlight"]')!;
  expect([mark.getAttribute("data-line"), mark.getAttribute("data-end"), mark.style.top, mark.style.height]).toEqual(["42", "44", `${8 + 41 * 20}px`, "60px"]);
  expect(host.querySelector<HTMLElement>('[data-slot="file-code"]')!.scrollTop).toBe(38 * 20);
});

test("text: numbered from the part's first line, never wrapped, nothing marked without a line", async () => {
  serve(() => Response.json(dto({ path: "/tmp/a.ts", name: "a.ts", folder: "/tmp", kind: "text", text: "const a = 1;\nconst b = 2;\n" })));
  const host = await render({ path: "/tmp/a.ts" });
  expect(text(host, "file-line-numbers")).toBe("1\n2");
  expect(host.querySelector('[data-slot="file-text"]')!.className.split(/\s+/)).toContain("whitespace-pre");
  expect(host.querySelector('[data-slot="file-highlight"]') === null).toBe(true);
  expect(button(host, "Preview") === null).toBe(true);
});

// A JSON file reads formatted first: only its spaces and line breaks change,
// every value as stored, each kind of token marked; Source is the file.
const JSON_TEXT = '{"qwerasdf":{"sig":"north|dry||bed-3","count":12,"moisture":0.120,"last_trace":1234567890123456789,"muted":false,"note":null,"tags":["a","b"]}}\n';
const JSON_FORMATTED = [
  "{",
  '  "qwerasdf": {',
  '    "sig": "north|dry||bed-3",',
  '    "count": 12,',
  '    "moisture": 0.120,',
  '    "last_trace": 1234567890123456789,',
  '    "muted": false,',
  '    "note": null,',
  '    "tags": [',
  '      "a",',
  '      "b"',
  "    ]",
  "  }",
  "}"
].join("\n");
const jsonFile = (over: Partial<FileDto> = {}) => dto({ path: "/tmp/data/known.json", name: "known.json", folder: "/tmp/data", kind: "text", text: JSON_TEXT, ...over });
const tokens = (host: HTMLElement, kind: string) => [...host.querySelectorAll(`[data-slot="file-text"] [data-token="${kind}"]`)].map((t) => t.textContent);

test("a JSON file reads formatted first, every value as stored; Source shows the file as it is", async () => {
  serve(() => Response.json(jsonFile()));
  const host = await render({ path: "/tmp/data/known.json" });
  expect(button(host, "Formatted")!.getAttribute("aria-pressed")).toBe("true");
  expect(text(host, "file-text")).toBe(JSON_FORMATTED);
  expect(text(host, "file-line-numbers")).toBe(Array.from({ length: 14 }, (_, i) => i + 1).join("\n"));
  await press(button(host, "Source"));
  expect(text(host, "file-text")).toBe(JSON_TEXT.trimEnd());
  expect(text(host, "file-line-numbers")).toBe("1");
  expect(host.querySelector('[data-slot="file-text"] [data-token]') === null).toBe(true);
});

test("formatted JSON marks its keys, text, numbers and true/false/null", async () => {
  serve(() => Response.json(jsonFile()));
  const host = await render({ path: "/tmp/data/known.json" });
  expect(tokens(host, "key")).toEqual(['"qwerasdf"', '"sig"', '"count"', '"moisture"', '"last_trace"', '"muted"', '"note"', '"tags"']);
  expect(tokens(host, "string")).toEqual(['"north|dry||bed-3"', '"a"', '"b"']);
  expect(tokens(host, "number")).toEqual(["12", "0.120", "1234567890123456789"]);
  expect(tokens(host, "literal")).toEqual(["false", "null"]);
});

test("a JSON file with comments formats too, its comments kept", async () => {
  serve(() => Response.json(jsonFile({ path: "/tmp/data/tsconfig.json", name: "tsconfig.json", text: '{"strict":true, // checked\n"lib":["es2023",],}\n' })));
  const host = await render({ path: "/tmp/data/tsconfig.json" });
  expect(text(host, "file-text")).toBe('{\n  "strict": true, // checked\n  "lib": [\n    "es2023",\n  ],\n}');
});

test("a link that names lines opens a JSON file on Source, its lines marked; Formatted marks none", async () => {
  serve(() => Response.json(jsonFile({ text: '{"a":1,\n"b":2}\n' })));
  const host = await render({ path: "/tmp/data/known.json", line: 2 });
  expect(button(host, "Source")!.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector('[data-slot="file-highlight"]')!.getAttribute("data-line")).toBe("2");
  await press(button(host, "Formatted"));
  expect(text(host, "file-text")).toBe('{\n  "a": 1,\n  "b": 2\n}');
  expect(host.querySelector('[data-slot="file-highlight"]') === null).toBe(true);
});

test("no Formatted for a file that is not JSON, for part of a large one, or for JSON in a file of another name", async () => {
  serve(() => Response.json(jsonFile({ text: '{"a": 1,\n' })));
  let host = await render({ path: "/tmp/data/known.json" });
  expect([button(host, "Formatted"), button(host, "Source")]).toEqual([null, null]);
  expect(text(host, "file-text")).toBe('{"a": 1,');
  runCleanups();
  serve(() => Response.json(jsonFile({ size: 9_000_000, part: "start", firstLine: 1, text: '{"a":1,"b":\n' })));
  host = await render({ path: "/tmp/data/known.json" });
  expect(button(host, "Formatted")).toBeNull();
  runCleanups();
  serve(() => Response.json(jsonFile({ path: "/tmp/data/known.txt", name: "known.txt" })));
  host = await render({ path: "/tmp/data/known.txt" });
  expect(button(host, "Formatted")).toBeNull();
  expect(text(host, "file-text")).toBe(JSON_TEXT.trimEnd());
});

test("a JSON file too large to colour quickly reads formatted, without colours", async () => {
  const entry = (i: number) => `"k${i}":{"v":${i},"s":"${"x".repeat(40)}"}`;
  const entries: string[] = [];
  let size = 2;
  for (let i = 0; size <= JSON_COLOR_MAX_CHARS; i++) { const e = entry(i); entries.push(e); size += e.length + 1; }
  serve(() => Response.json(jsonFile({ size, text: `{${entries.join(",")}}` })));
  const host = await render({ path: "/tmp/data/known.json" });
  expect(button(host, "Formatted")!.getAttribute("aria-pressed")).toBe("true");
  expect(text(host, "file-text")!.startsWith('{\n  "k0": {\n    "v": 0,')).toBe(true);
  expect(host.querySelector('[data-slot="file-text"] [data-token]') === null).toBe(true);
});

test("a large text: the first part, then the end on asking, then the start again; a line in neither shows the part around it", async () => {
  const reads = serve((url) => {
    const part = url.searchParams.get("part");
    const line = url.searchParams.get("line");
    const base = { path: "/tmp/big.log", name: "big.log", folder: "/tmp", kind: "text" as const, size: 50_646_221 };
    if (part === "end") return Response.json(dto({ ...base, text: "line 4999998\nline 4999999\n", part: "end", firstLine: 4_999_998 }));
    if (line) return Response.json(dto({ ...base, text: "line 500000\n", part: "around", firstLine: 500_000 }));
    return Response.json(dto({ ...base, text: "line 1\n", part: "start", firstLine: 1 }));
  });
  const host = await render({ path: "/tmp/big.log" });
  expect(text(host, "file-part")).toBe("Showing the first 2 MB of 48.3 MBShow the end");
  await press(button(host, "Show the end"));
  await settleUntil(() => text(host, "file-part")?.startsWith("Showing the last") ?? false, "the end");
  expect(text(host, "file-part")).toBe("Showing the last 2 MB of 48.3 MBShow the start");
  expect(text(host, "file-line-numbers")).toBe("4999998\n4999999");
  await press(button(host, "Show the start"));
  await settleUntil(() => text(host, "file-part")?.startsWith("Showing the first") ?? false, "the start");
  expect(reads.map((u) => u.searchParams.get("part"))).toStrictEqual([null, "end", "start"]);
  runCleanups();
  serve((url) => {
    const base = { path: "/tmp/big.log", name: "big.log", folder: "/tmp", kind: "text" as const, size: 50_646_221 };
    return Response.json(url.searchParams.get("line") === "500000" ? dto({ ...base, text: "line 500000\n", part: "around", firstLine: 500_000 }) : dto(base));
  });
  const around = await render({ path: "/tmp/big.log", line: 500_000 });
  expect(text(around, "file-part")).toBe("Showing 2 MB around line 500,000 of 48.3 MBShow the startShow the end");
  expect(around.querySelector<HTMLElement>('[data-slot="file-highlight"]')!.style.top).toBe("8px");
});

test("an image shows from the server and opens larger; one over 20 MiB is not shown", async () => {
  serve(() => Response.json(dto({ path: "/tmp/shot.png", name: "shot.png", folder: "/tmp", kind: "image", text: undefined, size: 182_000 })));
  const host = await render({ path: "/tmp/shot.png" });
  const img = host.querySelector<HTMLImageElement>('[data-slot="file-image"]')!;
  expect(new URL(img.getAttribute("src")!, "http://mandate.test").pathname).toBe("/api/files/raw");
  expect(img.closest('[data-slot="image-open"]')).not.toBeNull();
  runCleanups();
  serve(() => Response.json(dto({ path: "/tmp/huge.png", name: "huge.png", folder: "/tmp", kind: "image", text: undefined, size: 21_000_000 })));
  const huge = await render({ path: "/tmp/huge.png" });
  expect(huge.querySelector('[data-slot="file-image"]') === null).toBe(true);
  expect(huge.textContent).toContain("This image is too large to show here.");
  expect(huge.textContent).toContain("20.0 MB");
});

test("HTML previews in a sandbox with no same origin; a PDF offers the browser; anything else says it can't be shown", async () => {
  serve(() => Response.json(dto({ path: "/tmp/page.html", name: "page.html", folder: "/tmp", kind: "html", text: "<h1>Hi</h1>" })));
  const html = await render({ path: "/tmp/page.html" });
  const frame = html.querySelector<HTMLIFrameElement>('[data-slot="file-html"]')!;
  expect(frame.getAttribute("sandbox")!.split(" ")).not.toContain("allow-same-origin");
  expect(frame.getAttribute("srcdoc")).toContain("<h1>Hi</h1>");
  expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
  runCleanups();
  serve(() => Response.json(dto({ path: "/tmp/spec.pdf", name: "spec.pdf", folder: "/tmp", kind: "pdf", text: undefined, size: 2048 })));
  const pdf = await render({ path: "/tmp/spec.pdf" });
  const open = [...pdf.querySelectorAll("a")].find((a) => a.textContent === "Open in browser")!;
  expect([new URL(open.href).pathname, open.target]).toEqual(["/api/files/raw", "_blank"]);
  runCleanups();
  serve(() => Response.json(dto({ path: "/tmp/tool", name: "tool", folder: "/tmp", kind: "other", text: undefined, size: 512 })));
  const other = await render({ path: "/tmp/tool" });
  expect(other.textContent).toContain("This kind of file can't be shown here.");
  expect(other.textContent).toContain("512 B");
});

test("each refusal in its words; a failure to reach the server says so with what went wrong", async () => {
  const cases: Array<[string, number, string[]]> = [
    ["missing", 404, ["File not found", "It may have been moved or deleted."]],
    ["outside", 403, ["This file is outside the folders Mandate shows.", "Project folders, their worktrees, Mandate's resources and temporary folders can be opened."]],
    ["folder", 409, ["This is a folder.", "Only files can be opened here."]]
  ];
  for (const [code, status, words] of cases) {
    serve(() => Response.json({ error: "x", code }, { status }));
    const host = await render({ path: "/tmp/x" });
    for (const w of words) expect([code, host.textContent?.includes(w)]).toEqual([code, true]);
    runCleanups();
  }
  mockFetch(() => { throw new TypeError("Failed to fetch"); });
  const host = await render({ path: "/tmp/x" });
  expect(host.textContent).toContain("Couldn't open the file.");
  expect(host.textContent).toContain("Failed to fetch");
});

test("its close button, over the page, asks to close", async () => {
  serve(() => Response.json(dto()));
  let closed = 0;
  const host = await render({ path: "/tmp/project-1/docs/report.md" }, { onClose: () => { closed += 1; } });
  await press(button(host, "Close file"));
  expect(closed).toBe(1);
});

test("a panel's tab reads the file again each time it comes back into sight", async () => {
  const reads = serve(() => Response.json(dto()));
  const target = { path: "/tmp/project-1/docs/report.md" };
  const view = (shown: boolean) => <MemoryRouter><FileView target={target} presentation="panel" shown={shown} /></MemoryRouter>;
  const mounted = await mountAsync(view(true));
  await settleUntil(() => reads.length === 1 && text(mounted.host, "file-meta") !== null, "the first read");
  await act(async () => { mounted.rerender(view(false)); });
  await act(async () => { mounted.rerender(view(true)); });
  await settleUntil(() => reads.length === 2, "the read when it came back");
  expect(reads).toHaveLength(2);
});

test("pictures load again when the tab comes back: an image file's, and those of a Markdown file shown", async () => {
  for (const [file, selector] of [
    [dto({ path: "/tmp/shot.png", name: "shot.png", folder: "/tmp", kind: "image", text: undefined, size: 182_000 }), '[data-slot="file-image"]'],
    [dto(), '[data-slot="markdown"] img']
  ] as const) {
    const reads = serve(() => Response.json(file));
    const target = { path: file.path };
    const view = (shown: boolean) => <MemoryRouter><FileView target={target} presentation="panel" shown={shown} /></MemoryRouter>;
    const mounted = await mountAsync(view(true));
    await settleUntil(() => mounted.host.querySelector(selector) !== null, "the picture");
    const first = mounted.host.querySelector(selector)!.getAttribute("src");
    await act(async () => { mounted.rerender(view(false)); });
    await act(async () => { mounted.rerender(view(true)); });
    await settleUntil(() => reads.length === 2 && mounted.host.querySelector(selector)!.getAttribute("src") !== first, "the picture asked for again");
    expect(new URL(mounted.host.querySelector(selector)!.getAttribute("src")!, "http://mandate.test").searchParams.get("path")).toBe(new URL(first!, "http://mandate.test").searchParams.get("path"));
    runCleanups();
  }
});

test("opened again at the same line, the line comes back into view", async () => {
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  serve(() => Response.json(dto({ path: "/tmp/a.ts", name: "a.ts", folder: "/tmp", kind: "text", text: lines })));
  const target = { path: "/tmp/a.ts", line: 42 };
  const view = (opened: number) => <MemoryRouter><FileView target={target} presentation="panel" opened={opened} /></MemoryRouter>;
  const mounted = await mountAsync(view(1));
  await settleUntil(() => mounted.host.querySelector('[data-slot="file-highlight"]') !== null, "the line marked");
  const code = mounted.host.querySelector<HTMLElement>('[data-slot="file-code"]')!;
  expect(code.scrollTop).toBe(38 * 20);
  code.scrollTop = 0;
  await act(async () => { mounted.rerender(view(2)); });
  expect(code.scrollTop).toBe(38 * 20);
});

test("a Markdown file in a folder whose name has # or ? still finds its pictures and links", async () => {
  serve(() => Response.json(dto({ path: "/tmp/C#/what?/docs/report.md", folder: "/tmp/C#/what?/docs", text: "![shot](shot.png) [plan](plan.md#L4)\n" })));
  const host = await render({ path: "/tmp/C#/what?/docs/report.md" });
  const img = host.querySelector<HTMLImageElement>('[data-slot="markdown"] img')!;
  expect(new URL(img.getAttribute("src")!, "http://mandate.test").searchParams.get("path")).toBe("/tmp/C#/what?/docs/shot.png");
  const link = host.querySelector('[data-slot="markdown"] a[data-file-link]')!;
  expect(link.getAttribute("data-file-link")).toBe("/tmp/C#/what?/docs/plan.md");
  expect(link.getAttribute("href")).toContain("line=4");
});
