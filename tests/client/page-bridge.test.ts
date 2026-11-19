import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { agentPageScript, pagePathOf, readPageFrameMessage } from "@/routes/personal/page/page-bridge";
import { canvasRuntimeScript } from "@/routes/canvas/canvas-bridge";

const PAGE = "agent-page";

interface Mandate {
  data(name: string): Promise<unknown>;
  onData(name: string, fn: (data: unknown) => void): void;
  submit(value: unknown): Promise<void>;
  open(path: string): void;
}

/** The runtime and the page script run in a window of their own, as in the
 *  frame, so their listeners never reach the shared test window. The frame's
 *  parent is itself here: what the script posts is caught on it. */
function pageWindow(html = "", place?: { path: string; pages: string[] }) {
  const frame = new Window({ url: "http://127.0.0.1:4173/api/agent-page/assets/" });
  const intrinsics = frame as unknown as Record<string, unknown>;
  for (const key of ["Error", "TypeError", "SyntaxError", "RangeError"]) intrinsics[key] ??= (globalThis as Record<string, unknown>)[key];
  frame.document.body.innerHTML = html;
  const sent: Array<Record<string, unknown>> = [];
  (frame as unknown as { postMessage: (data: Record<string, unknown>) => void }).postMessage = (data) => { sent.push(data); };
  const run = (script: string) => {
    const body = script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    new Function("window", "document", "MutationObserver", body)(frame, frame.document, frame.MutationObserver);
  };
  run(canvasRuntimeScript());
  run(agentPageScript(PAGE, place));
  const fromHost = (data: Record<string, unknown>) => {
    frame.dispatchEvent(new frame.MessageEvent("message", { data, source: frame as unknown as Window }));
  };
  const mandate = (frame as unknown as { mandate: Mandate }).mandate;
  return { frame, sent, fromHost, mandate, close: () => { void frame.happyDOM.abort(); } };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("mandate.data resolves with the host's answer to its get", async () => {
  const p = pageWindow();
  const answer = p.mandate.data("threads");
  const reqId = p.sent[0]!.reqId as number;
  expect(p.sent).toStrictEqual([{ type: "mandate.page.get", name: "threads", reqId, pageId: PAGE }]);
  // An answer to a request this page never made settles nothing.
  p.fromHost({ type: "mandate.page.result", reqId: reqId + 7, ok: true, data: { value: "wrong", at: null, error: null } });
  p.fromHost({ type: "mandate.page.result", reqId, ok: true, data: { value: [{ id: "thr_1" }], at: "2026-10-20T10:00:00.000Z", error: null } });
  expect(await answer).toEqual({ value: [{ id: "thr_1" }], at: "2026-10-20T10:00:00.000Z", error: null });
  p.close();
});

test("onData fires now and on each data message", async () => {
  const p = pageWindow();
  const seen: unknown[] = [];
  p.mandate.onData("soil-sensors", (data) => seen.push(data));
  p.mandate.onData("soil-sensors", (data) => seen.push(["second", data]));
  // One subscribe for the source, however many listen.
  expect(p.sent).toStrictEqual([{ type: "mandate.page.subscribe", name: "soil-sensors", pageId: PAGE }]);
  p.fromHost({ type: "mandate.page.data", name: "soil-sensors", data: { value: 1, at: null, error: null } });
  p.fromHost({ type: "mandate.page.data", name: "soil-sensors", data: { value: 2, at: null, error: null } });
  // Another source's data reaches none of them.
  p.fromHost({ type: "mandate.page.data", name: "tank-level", data: { value: 9, at: null, error: null } });
  expect(seen).toStrictEqual([
    { value: 1, at: null, error: null }, ["second", { value: 1, at: null, error: null }],
    { value: 2, at: null, error: null }, ["second", { value: 2, at: null, error: null }]
  ]);
  // A listener added later hears the latest at once.
  const late: unknown[] = [];
  p.mandate.onData("soil-sensors", (data) => late.push(data));
  expect(late).toStrictEqual([{ value: 2, at: null, error: null }]);
  p.close();
});

test("submit resolves with the host's result, and rejects with its error", async () => {
  const p = pageWindow();
  const kept = p.mandate.submit({ pick: "c" });
  const first = p.sent[0]!.reqId as number;
  expect(p.sent).toStrictEqual([{ type: "mandate.page.submit", value: { pick: "c" }, reqId: first, pageId: PAGE }]);
  p.fromHost({ type: "mandate.page.result", reqId: first, ok: true });
  expect(await kept).toBeUndefined();
  const refused = p.mandate.submit("x".repeat(9000));
  p.fromHost({ type: "mandate.page.result", reqId: p.sent.filter((m) => m.type === "mandate.page.submit")[1]!.reqId, ok: false, error: "an answer is at most 8 KB of JSON" });
  expect(await refused.then(() => "kept", (error: Error) => error.message)).toBe("an answer is at most 8 KB of JSON");
  p.close();
});

test("a click on a /threads/ link sends open and is prevented; an https link is not", () => {
  const p = pageWindow('<a id="t" href="/threads/thr_1?worker=wkr_2">t</a><a id="c" href="/canvas/cnv_9">c</a><a id="x" href="https://example.com/threads/thr_1">x</a><a id="j" href="javascript:alert(1)">j</a>');
  const click = (id: string) => {
    let prevented = false;
    const last = (event: Event) => { prevented = event.defaultPrevented; event.preventDefault(); };
    p.frame.addEventListener("click", last as never);
    p.frame.document.getElementById(id)!.dispatchEvent(new p.frame.MouseEvent("click", { bubbles: true, cancelable: true }));
    p.frame.removeEventListener("click", last as never);
    return prevented;
  };
  expect([click("t"), click("c"), click("x"), click("j")]).toEqual([true, true, false, false]);
  expect(p.sent.filter((m) => m.type === "mandate.page.open")).toStrictEqual([
    { type: "mandate.page.open", path: "/threads/thr_1?worker=wkr_2", pageId: PAGE },
    { type: "mandate.page.open", path: "/canvas/cnv_9", pageId: PAGE }
  ]);
  p.close();
});

test("a link to another page of the site sends go and is prevented; a file that is not a page, Mandate's pages and other sites are not", () => {
  const links: Record<string, string> = {
    sibling: "one.html", up: "../index.html", root: "/index.html", spaced: "../a%20b.html", hashed: "one.html#open",
    css: "../style.css", missing: "../missing.html", thread: "/threads/thr_1", site: "https://example.com/index.html", top: "#top", proto: "//example.com/index.html"
  };
  const p = pageWindow(Object.entries(links).map(([id, href]) => `<a id="${id}" href="${href}">${id}</a>`).join(""), {
    path: "orders/list.html",
    pages: ["index.html", "orders/list.html", "orders/one.html", "a b.html"]
  });
  const prevented: Record<string, boolean> = {};
  for (const id of Object.keys(links)) {
    const last = (event: Event) => { prevented[id] = event.defaultPrevented; event.preventDefault(); };
    p.frame.addEventListener("click", last as never);
    p.frame.document.getElementById(id)!.dispatchEvent(new p.frame.MouseEvent("click", { bubbles: true, cancelable: true }));
    p.frame.removeEventListener("click", last as never);
  }
  // An #id link is the runtime's: it scrolls in place.
  expect(prevented).toEqual({ sibling: true, up: true, root: true, spaced: true, hashed: true, css: false, missing: false, thread: true, site: false, top: true, proto: false });
  expect(p.sent.filter((m) => m.type === "mandate.page.go").map((m) => m.path)).toEqual(["orders/one.html", "index.html", "index.html", "a b.html", "orders/one.html"]);
  // Mandate's own page is opened, not gone to.
  expect(p.sent.filter((m) => m.type === "mandate.page.open").map((m) => m.path)).toEqual(["/threads/thr_1"]);
  p.close();
});

test("fields are collected and restored by id, also into a field a script adds later", async () => {
  const p = pageWindow('<input id="who" value=""><textarea id="note"></textarea><input id="ok" type="checkbox"><input id="secret" type="password" value="hunter2"><input value="no id">');
  const who = p.frame.document.getElementById("who") as unknown as HTMLInputElement;
  who.value = "gardener";
  who.dispatchEvent(new p.frame.Event("input", { bubbles: true }) as unknown as Event);
  // Only what the user edited.
  expect(p.sent.at(-1)).toEqual({ type: "mandate.page.fields", values: { who: "gardener" }, pageId: PAGE });
  p.sent.length = 0;
  p.fromHost({ type: "mandate.page.restore", values: { who: "back", ok: "true", later: "drawn later", secret: "x" } });
  // What the user typed here since wins over an older held value.
  expect(who.value).toBe("gardener");
  expect((p.frame.document.getElementById("ok") as unknown as HTMLInputElement).checked).toBe(true);
  expect((p.frame.document.getElementById("secret") as unknown as HTMLInputElement).value).toBe("hunter2");
  p.frame.document.body.insertAdjacentHTML("beforeend", '<input id="later">');
  await tick();
  expect((p.frame.document.getElementById("later") as unknown as HTMLInputElement).value).toBe("drawn later");
  p.close();
});

test("a held value comes back into a field rebuilt after the load, and once edited the edit does", async () => {
  const p = pageWindow('<div id="form"><input id="who"></div>');
  p.fromHost({ type: "mandate.page.restore", values: { who: "gardener" } });
  const form = p.frame.document.getElementById("form")!;
  const who = () => p.frame.document.getElementById("who") as unknown as HTMLInputElement;
  expect(who().value).toBe("gardener");
  // The page's data arrives and draws the form again.
  form.innerHTML = '<input id="who">';
  await tick();
  expect(who().value).toBe("gardener");
  // Once the user edits it, what they now typed is what comes back.
  who().value = "keeper";
  who().dispatchEvent(new p.frame.Event("input", { bubbles: true }) as unknown as Event);
  form.innerHTML = '<input id="who">';
  await tick();
  expect(who().value).toBe("keeper");
  p.close();
});

test("a select's held value waits for the option it names", async () => {
  const p = pageWindow('<select id="wing"></select>');
  p.fromHost({ type: "mandate.page.restore", values: { wing: "south" } });
  const select = p.frame.document.getElementById("wing") as unknown as HTMLSelectElement;
  select.insertAdjacentHTML("beforeend", '<option value="north">north</option><option value="south">south</option>');
  await tick();
  expect(select.value).toBe("south");
  p.close();
});

test("request ids start apart in each document, so a reloaded page never takes an answer meant for the one before", () => {
  const firstIds = Array.from({ length: 5 }, () => {
    const p = pageWindow();
    void p.mandate.data("threads");
    const id = p.sent[0]!.reqId as number;
    p.close();
    return id;
  });
  expect(new Set(firstIds).size).toBe(5);
  for (const id of firstIds) expect(Number.isSafeInteger(id) && id > 0).toBe(true);
});

test("on load the page says whether a field has focus", () => {
  const p = pageWindow('<input id="who">');
  (p.frame.document.getElementById("who") as unknown as HTMLInputElement).focus();
  p.sent.length = 0;
  p.frame.dispatchEvent(new p.frame.Event("load"));
  expect(p.sent.filter((m) => m.type === "mandate.page.focus")).toStrictEqual([{ type: "mandate.page.focus", inField: true, pageId: PAGE }]);
  p.close();
  const fresh = pageWindow('<input id="who">');
  fresh.frame.dispatchEvent(new fresh.frame.Event("load"));
  expect(fresh.sent.filter((m) => m.type === "mandate.page.focus")).toStrictEqual([{ type: "mandate.page.focus", inField: false, pageId: PAGE }]);
  fresh.close();
});

test("focus reports a field gaining and losing focus", async () => {
  const p = pageWindow('<input id="who"><button id="b">b</button>');
  (p.frame.document.getElementById("who") as unknown as HTMLInputElement).focus();
  expect(p.sent.filter((m) => m.type === "mandate.page.focus").at(-1)).toEqual({ type: "mandate.page.focus", inField: true, pageId: PAGE });
  (p.frame.document.getElementById("b") as unknown as HTMLButtonElement).focus();
  await tick();
  expect(p.sent.filter((m) => m.type === "mandate.page.focus").at(-1)).toEqual({ type: "mandate.page.focus", inField: false, pageId: PAGE });
  p.close();
});

test("the host drops page messages of the wrong shape, an oversized submit, and paths that are not Mandate's", () => {
  const read = (data: unknown) => readPageFrameMessage(data, PAGE);
  // Well formed.
  expect(read({ type: "mandate.page.get", name: "threads", reqId: 1, pageId: PAGE })).toEqual({ type: "get", name: "threads", reqId: 1 });
  expect(read({ type: "mandate.page.subscribe", name: "soil-sensors", pageId: PAGE })).toEqual({ type: "subscribe", name: "soil-sensors" });
  expect(read({ type: "mandate.page.open", path: "/home", pageId: PAGE })).toEqual({ type: "open", path: "/home" });
  expect(read({ type: "mandate.page.go", path: "orders/list.html", pageId: PAGE })).toEqual({ type: "go", path: "orders/list.html" });
  expect(read({ type: "mandate.page.submit", value: { pick: "c" }, reqId: 3, pageId: PAGE })).toEqual({ type: "submit", value: { pick: "c" }, reqId: 3 });
  // Junk: another page, no type, a bad name or id.
  for (const junk of [
    null, "mandate.page.get", { type: "mandate.page.get", name: "threads", reqId: 1, pageId: "other" },
    { type: "mandate.page.get", name: "../etc", reqId: 1, pageId: PAGE }, { type: "mandate.page.get", name: "threads", reqId: 0, pageId: PAGE },
    { type: "mandate.page.get", name: "threads", reqId: "1", pageId: PAGE }, { type: "mandate.canvas.go", path: "x", pageId: PAGE },
    { type: "mandate.page.focus", inField: "yes", pageId: PAGE }, { type: "mandate.page.fields", values: [], pageId: PAGE },
    { type: "mandate.page.go", path: "", pageId: PAGE }, { type: "mandate.page.go", path: 3, pageId: PAGE }, { type: "mandate.page.go", path: `${"x".repeat(2000)}.html`, pageId: PAGE }
  ]) expect(read(junk)).toBeNull();
  // A 1 MB submit, or one that is not JSON, is refused with why.
  expect(read({ type: "mandate.page.submit", value: "x".repeat(1_000_000), reqId: 4, pageId: PAGE })).toEqual({ type: "refused", reqId: 4, error: "an answer is at most 8 KB of JSON" });
  expect(read({ type: "mandate.page.submit", value: "é".repeat(4_096), reqId: 5, pageId: PAGE })).toMatchObject({ type: "refused" });
  expect(read({ type: "mandate.page.submit", value: undefined, reqId: 6, pageId: PAGE })).toEqual({ type: "refused", reqId: 6, error: "submit takes a JSON value" });
  // What a message can carry and JSON cannot is refused, not turned into {}.
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [new Map([["a", 1]]), new Set([1]), new ArrayBuffer(10_000), new Date(0), cycle, [Number.NaN], { a: new Uint8Array(4) }]) {
    expect(read({ type: "mandate.page.submit", value, reqId: 7, pageId: PAGE })).toEqual({ type: "refused", reqId: 7, error: "submit takes a JSON value" });
  }
  expect(read({ type: "mandate.page.submit", value: { a: [1, "b", null, true, { c: 2 }] }, reqId: 8, pageId: PAGE })).toMatchObject({ type: "submit" });
  // A field left undefined goes as JSON has it: the key dropped, an array's slot null.
  const loose = { pick: "c", note: undefined, marks: [1, undefined] };
  expect(read({ type: "mandate.page.submit", value: loose, reqId: 10, pageId: PAGE })).toEqual({ type: "submit", value: loose, reqId: 10 });
  expect(JSON.stringify(loose)).toBe('{"pick":"c","marks":[1,null]}');
  // One value shared many times over: refused at once, not walked 2^40 times.
  let shared: unknown = 1;
  for (let i = 0; i < 40; i += 1) shared = [shared, shared];
  const started = performance.now();
  expect(read({ type: "mandate.page.submit", value: shared, reqId: 9, pageId: PAGE })).toMatchObject({ type: "refused" });
  expect(performance.now() - started).toBeLessThan(1000);
  // One large string or key shared many times over: refused by counting,
  // before any JSON is built.
  const stringify = JSON.stringify;
  let longest = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const text = stringify(...args);
    longest = Math.max(longest, text?.length ?? 0);
    return text;
  }) as typeof JSON.stringify;
  try {
    expect(read({ type: "mandate.page.submit", value: Array(2000).fill({ s: "x".repeat(32_768) }), reqId: 11, pageId: PAGE })).toEqual({ type: "refused", reqId: 11, error: "an answer is at most 8 KB of JSON" });
    expect(read({ type: "mandate.page.submit", value: Array(500).fill("x".repeat(32_768)), reqId: 13, pageId: PAGE })).toEqual({ type: "refused", reqId: 13, error: "an answer is at most 8 KB of JSON" });
    expect(read({ type: "mandate.page.submit", value: Array(2000).fill({ ["k".repeat(32_768)]: 1 }), reqId: 12, pageId: PAGE })).toEqual({ type: "refused", reqId: 12, error: "an answer is at most 8 KB of JSON" });
  } finally {
    JSON.stringify = stringify;
  }
  expect(longest).toBeLessThan(100_000);
  // The limit is exact: a string of 8,190 characters is 8,192 bytes as JSON.
  expect(read({ type: "mandate.page.submit", value: "x".repeat(8190), reqId: 14, pageId: PAGE })).toMatchObject({ type: "submit" });
  expect(read({ type: "mandate.page.submit", value: "x".repeat(8191), reqId: 15, pageId: PAGE })).toMatchObject({ type: "refused" });
  // An array's own methods are never called.
  expect(read({ type: "mandate.page.submit", value: Object.assign([1, 2], { every: 0 }), reqId: 10, pageId: PAGE })).toMatchObject({ type: "submit" });
  // Paths: only Mandate's pages.
  for (const path of ["https://evil.example", "javascript:alert(1)", "//evil.example/threads/x", "/threads/x/../../etc", "/threads/", "/api/agent-page", "/canvas/a b", "threads/x", "/home?x=1", "/threads/thr_1?worker=a&b=c"]) {
    expect([path, pagePathOf(path)]).toEqual([path, null]);
    expect(read({ type: "mandate.page.open", path, pageId: PAGE })).toBeNull();
  }
  for (const path of ["/home", "/threads/thr_1", "/threads/thr_1?worker=wkr_2", "/canvas/cnv_9"]) expect(pagePathOf(path)).toBe(path);
  // Fields keep strings only, within their limits.
  expect(read({ type: "mandate.page.fields", values: { a: "x", b: 3, c: "y".repeat(20_001) }, pageId: PAGE })).toEqual({ type: "fields", values: { a: "x" } });
});

// ── What the user typed, and only that ───────────────────────────────────
test("only fields the user edited are held; one the page fills itself keeps following its data", () => {
  const p = pageWindow('<input id="eta" value="3pm"><textarea id="note"></textarea>');
  const note = p.frame.document.getElementById("note") as unknown as HTMLTextAreaElement;
  note.value = "hello";
  note.dispatchEvent(new p.frame.Event("input", { bubbles: true }) as unknown as Event);
  expect(p.sent.filter((m) => m.type === "mandate.page.fields").at(-1)).toEqual({ type: "mandate.page.fields", values: { note: "hello" }, pageId: PAGE });
  p.close();
});

test("what the user typed comes back into a field the page rebuilds in the same document; a submit that went through lets it go", async () => {
  const p = pageWindow('<div id="form"><textarea id="note"></textarea></div>');
  const form = p.frame.document.getElementById("form")!;
  const note = () => p.frame.document.getElementById("note") as unknown as HTMLTextAreaElement;
  note().value = "hello";
  note().dispatchEvent(new p.frame.Event("input", { bubbles: true }) as unknown as Event);
  // New data: the page draws its form again.
  form.innerHTML = '<textarea id="note"></textarea>';
  await tick();
  expect(note().value).toBe("hello");
  // The user sends it: what they typed is done with.
  const sent = p.mandate.submit({ note: "hello" });
  p.fromHost({ type: "mandate.page.result", reqId: p.sent.filter((m) => m.type === "mandate.page.submit").at(-1)!.reqId, ok: true });
  await sent;
  expect(p.sent.filter((m) => m.type === "mandate.page.fields").at(-1)).toEqual({ type: "mandate.page.fields", values: {}, pageId: PAGE });
  form.innerHTML = '<textarea id="note"></textarea>';
  await tick();
  expect(note().value).toBe("");
  p.close();
});

test("a page field losing focus to the app counts as leaving it", () => {
  const p = pageWindow('<input id="who">');
  (p.frame.document.getElementById("who") as unknown as HTMLInputElement).focus();
  // The user clicked the chat's composer: the frame's window loses focus,
  // though its input is still its active element.
  p.frame.dispatchEvent(new p.frame.Event("blur"));
  expect(p.sent.filter((m) => m.type === "mandate.page.focus").at(-1)).toEqual({ type: "mandate.page.focus", inField: false, pageId: PAGE });
  p.close();
});

test("a radio picked in a group holds the others as unpicked, so the choice comes back as made", async () => {
  const p = pageWindow('<div id="form"><input type="radio" name="env" id="a"><input type="radio" name="env" id="b"></div>');
  const radio = (id: string) => p.frame.document.getElementById(id) as unknown as HTMLInputElement;
  const pick = (id: string) => {
    radio(id).checked = true;
    radio(id).dispatchEvent(new p.frame.Event("change", { bubbles: true }) as unknown as Event);
  };
  pick("b");
  pick("a");
  const form = p.frame.document.getElementById("form")!;
  form.innerHTML = '<input type="radio" name="env" id="a"><input type="radio" name="env" id="b">';
  await tick();
  expect([radio("a").checked, radio("b").checked]).toEqual([true, false]);
  p.close();
});

test("a radio picked while another of its group is not drawn still unpicks that one", async () => {
  const p = pageWindow('<div id="form"><input type="radio" name="env" id="a"><input type="radio" name="env" id="b"></div>');
  const radio = (id: string) => p.frame.document.getElementById(id) as unknown as HTMLInputElement;
  const pick = (id: string) => {
    radio(id).checked = true;
    radio(id).dispatchEvent(new p.frame.Event("change", { bubbles: true }) as unknown as Event);
  };
  pick("a");
  radio("a").remove();
  pick("b");
  p.frame.document.getElementById("form")!.insertAdjacentHTML("afterbegin", '<input type="radio" name="env" id="a">');
  await tick();
  expect([radio("a").checked, radio("b").checked]).toEqual([false, true]);
  p.close();
});

test("same-named radios in separate forms are separate groups", async () => {
  const p = pageWindow('<div id="area"><form id="f1"><input type="radio" name="env" id="a1"><input type="radio" name="env" id="b1"></form><form id="f2"><input type="radio" name="env" id="a2"><input type="radio" name="env" id="b2"></form></div>');
  const radio = (id: string) => p.frame.document.getElementById(id) as unknown as HTMLInputElement;
  const pick = (id: string) => {
    radio(id).checked = true;
    radio(id).dispatchEvent(new p.frame.Event("change", { bubbles: true }) as unknown as Event);
  };
  pick("a1");
  pick("b2");
  p.frame.document.getElementById("area")!.innerHTML = '<form id="f1"><input type="radio" name="env" id="a1"><input type="radio" name="env" id="b1"></form><form id="f2"><input type="radio" name="env" id="a2"><input type="radio" name="env" id="b2"></form>';
  await tick();
  expect([radio("a1").checked, radio("b1").checked, radio("a2").checked, radio("b2").checked]).toEqual([true, false, false, true]);
  p.close();
});

test("a radio given back in a new version gives way to a later pick, even once it is not drawn", async () => {
  // The first version: the user picks a; what is held goes to the host.
  const first = pageWindow('<input type="radio" name="env" id="a"><input type="radio" name="env" id="b">');
  const firstRadio = first.frame.document.getElementById("a") as unknown as HTMLInputElement;
  firstRadio.checked = true;
  firstRadio.dispatchEvent(new first.frame.Event("change", { bubbles: true }) as unknown as Event);
  const held = first.sent.filter((m) => m.type === "mandate.page.fields").at(-1)!.values as Record<string, string>;
  first.close();
  // The next version gets it back; then a goes, the user picks b, and a returns.
  const p = pageWindow('<div id="area"><input type="radio" name="env" id="a"><input type="radio" name="env" id="b"></div>');
  const radio = (id: string) => p.frame.document.getElementById(id) as unknown as HTMLInputElement;
  p.fromHost({ type: "mandate.page.restore", values: held });
  expect([radio("a").checked, radio("b").checked]).toEqual([true, false]);
  radio("a").remove();
  radio("b").checked = true;
  radio("b").dispatchEvent(new p.frame.Event("change", { bubbles: true }) as unknown as Event);
  p.frame.document.getElementById("area")!.insertAdjacentHTML("beforeend", '<input type="radio" name="env" id="a">');
  await tick();
  expect([radio("a").checked, radio("b").checked]).toEqual([false, true]);
  p.close();
});

test("the host's clear lets go of what this document kept", async () => {
  const p = pageWindow('<div id="form"><input id="who"></div>');
  const who = () => p.frame.document.getElementById("who") as unknown as HTMLInputElement;
  who().value = "gardener";
  who().dispatchEvent(new p.frame.Event("input", { bubbles: true }) as unknown as Event);
  p.fromHost({ type: "mandate.page.clear" });
  p.frame.document.getElementById("form")!.innerHTML = '<input id="who">';
  await tick();
  expect(who().value).toBe("");
  p.close();
});

test("a radio group in a form with no id, drawn again with other members, keeps the latest pick", async () => {
  const p = pageWindow('<div id="area"><form><input type="radio" name="env" id="a"><input type="radio" name="env" id="b"></form></div>');
  const radio = (id: string) => p.frame.document.getElementById(id) as unknown as HTMLInputElement;
  const pick = (id: string) => {
    radio(id).checked = true;
    radio(id).dispatchEvent(new p.frame.Event("change", { bubbles: true }) as unknown as Event);
  };
  const area = p.frame.document.getElementById("area")!;
  pick("a");
  area.innerHTML = '<form><input type="radio" name="env" id="b"></form>';
  await tick();
  pick("b");
  // Drawn again with a after b: given back last, an old pick of a would win.
  area.innerHTML = '<form><input type="radio" name="env" id="b"><input type="radio" name="env" id="a"></form>';
  await tick();
  expect([radio("a").checked, radio("b").checked]).toEqual([false, true]);
  p.close();
});

test("a form with a control named id still keeps its radio group apart from another's", async () => {
  const html = '<form><input type="hidden" name="id" value="1"><input type="radio" name="env" id="a1"><input type="radio" name="env" id="b1"></form>' +
    '<form><input type="hidden" name="id" value="2"><input type="radio" name="env" id="a2"><input type="radio" name="env" id="b2"></form>';
  const p = pageWindow(`<div id="area">${html}</div>`);
  const radio = (id: string) => p.frame.document.getElementById(id) as unknown as HTMLInputElement;
  // As browsers do (happy-dom does not): form.id is the control named id,
  // which reads as "[object HTMLInputElement]" in a string.
  const shadow = () => {
    for (const form of Array.from(p.frame.document.forms)) {
      Object.defineProperty(form, "id", { configurable: true, get: () => ({ toString: () => "[object HTMLInputElement]" }) });
    }
  };
  shadow();
  const pick = (id: string) => {
    radio(id).checked = true;
    radio(id).dispatchEvent(new p.frame.Event("change", { bubbles: true }) as unknown as Event);
  };
  pick("a1");
  pick("b2");
  p.frame.document.getElementById("area")!.innerHTML = html;
  shadow();
  await tick();
  expect([radio("a1").checked, radio("b1").checked, radio("a2").checked, radio("b2").checked]).toEqual([true, false, false, true]);
  p.close();
});

test("a radio with no id picked in a group lets go of the group's earlier pick", async () => {
  const html = '<input type="radio" name="env" id="a"><input type="radio" name="env" class="other">';
  const p = pageWindow(`<div id="area">${html}</div>`);
  const a = () => p.frame.document.getElementById("a") as unknown as HTMLInputElement;
  a().checked = true;
  a().dispatchEvent(new p.frame.Event("change", { bubbles: true }) as unknown as Event);
  const other = p.frame.document.querySelector(".other") as unknown as HTMLInputElement;
  other.checked = true;
  other.dispatchEvent(new p.frame.Event("change", { bubbles: true }) as unknown as Event);
  p.frame.document.getElementById("area")!.innerHTML = html;
  await tick();
  expect(a().checked).toBe(false);
  p.close();
});

test("a radio the page draws checked does not take the group from the user's pick", async () => {
  const p = pageWindow('<div id="area"><input type="radio" name="env" id="a"><input type="radio" name="env" id="b"></div>');
  const radio = (id: string) => p.frame.document.getElementById(id) as unknown as HTMLInputElement;
  radio("a").checked = true;
  radio("a").dispatchEvent(new p.frame.Event("change", { bubbles: true }) as unknown as Event);
  // The page adds a member drawn checked; the browser unchecks the user's pick.
  p.frame.document.getElementById("area")!.insertAdjacentHTML("beforeend", '<input type="radio" name="env" id="c" checked>');
  radio("a").checked = false;
  await tick();
  expect([radio("a").checked, radio("c").checked]).toEqual([true, false]);
  p.close();
});

test("a new theme's colors and fonts take the place of the page's stylesheet", () => {
  const p = pageWindow("<style data-mandate-page-style>:root{--mandate-bg:#fff}</style><p>Today</p>");
  const style = () => p.frame.document.querySelector("style[data-mandate-page-style]")!.textContent;
  p.fromHost({ type: "mandate.page.style", css: ":root{--mandate-bg:#141416}" });
  expect(style()).toBe(":root{--mandate-bg:#141416}");
  // Anything but a stylesheet's text changes nothing.
  p.fromHost({ type: "mandate.page.style", css: { bad: true } });
  expect(style()).toBe(":root{--mandate-bg:#141416}");
  p.close();
});

const QUOTE_PAGE = '<div id="order" data-quote="Order #12 waits for your review"><b id="order-title">Order #12</b></div>' +
  '<div id="own" data-quote=""><b>Frost</b>\n   warning  03:00</div><a id="link" href="/threads/thr_1">t</a><p id="plain">Notes</p>';

/** A click as the user's, on an element of the page: whether it was
 *  prevented, and whether the page's own handler (added after the head
 *  script, as a page's scripts are) heard it. */
function clickIn(p: ReturnType<typeof pageWindow>, id: string) {
  let heard = false;
  const pageHandler = () => { heard = true; };
  p.frame.document.addEventListener("click", pageHandler as never);
  const event = new p.frame.MouseEvent("click", { bubbles: true, cancelable: true });
  p.frame.document.getElementById(id)!.dispatchEvent(event);
  p.frame.document.removeEventListener("click", pageHandler as never);
  return { prevented: event.defaultPrevented, heard };
}

test("the page says on load whether it has an item to quote, and again as that changes", async () => {
  const p = pageWindow('<p id="plain">Notes</p>');
  p.frame.dispatchEvent(new p.frame.Event("load"));
  const said = () => p.sent.filter((m) => m.type === "mandate.page.quotable").map((m) => m.any);
  expect(said()).toEqual([false]);
  p.frame.document.getElementById("plain")!.setAttribute("data-quote", "Notes");
  await tick();
  expect(said()).toEqual([false, true]);
  // Another marked item changes nothing the host is told.
  const more = p.frame.document.createElement("div");
  more.setAttribute("data-quote", "More");
  p.frame.document.body.appendChild(more);
  await tick();
  expect(said()).toEqual([false, true]);
  p.frame.document.getElementById("plain")!.remove();
  more.remove();
  await tick();
  expect(said()).toEqual([false, true, false]);
  p.close();
});

test("while quoting, a click on a marked item sends its quote and the page hears nothing of it", () => {
  const p = pageWindow(QUOTE_PAGE);
  p.fromHost({ type: "mandate.page.quoting", on: true });
  expect(p.frame.document.documentElement.hasAttribute("data-mandate-quoting")).toBe(true);
  expect(clickIn(p, "order-title")).toEqual({ prevented: true, heard: false });
  expect(p.sent.filter((m) => m.type === "mandate.page.quote")).toStrictEqual([
    { type: "mandate.page.quote", text: "Order #12 waits for your review", pageId: PAGE }
  ]);
  p.close();
});

test("an item marked with an empty data-quote is quoted by its own text", () => {
  const p = pageWindow(QUOTE_PAGE);
  p.fromHost({ type: "mandate.page.quoting", on: true });
  clickIn(p, "own");
  const quote = p.sent.find((m) => m.type === "mandate.page.quote")!;
  // The host folds it to one line.
  expect(readPageFrameMessage(quote, PAGE)).toEqual({ type: "quote", text: "Frost warning 03:00" });
  p.close();
});

test("while quoting, a click anywhere else does nothing: no link is followed and the page hears nothing", () => {
  const p = pageWindow(QUOTE_PAGE);
  p.fromHost({ type: "mandate.page.quoting", on: true });
  expect(clickIn(p, "link")).toEqual({ prevented: true, heard: false });
  expect(clickIn(p, "plain")).toEqual({ prevented: true, heard: false });
  expect(p.sent.filter((m) => m.type === "mandate.page.open" || m.type === "mandate.page.quote")).toEqual([]);
  p.close();
});

test("once quoting ends, clicks are the page's again", () => {
  const p = pageWindow(QUOTE_PAGE);
  p.fromHost({ type: "mandate.page.quoting", on: true });
  p.fromHost({ type: "mandate.page.quoting", on: false });
  expect(p.frame.document.documentElement.hasAttribute("data-mandate-quoting")).toBe(false);
  expect(clickIn(p, "order-title")).toEqual({ prevented: false, heard: true });
  expect(clickIn(p, "link").prevented).toBe(true);
  expect(p.sent.filter((m) => m.type === "mandate.page.quote")).toEqual([]);
  expect(p.sent.filter((m) => m.type === "mandate.page.open")).toHaveLength(1);
  p.close();
});

test("while quoting, marked items take the keyboard: Enter quotes one, Esc ends the mode, and their tab stops go after", () => {
  const p = pageWindow(QUOTE_PAGE + '<div id="tabbed" data-quote="Has its own" tabindex="-1">x</div>');
  const el = (id: string) => p.frame.document.getElementById(id)!;
  p.fromHost({ type: "mandate.page.quoting", on: true });
  expect([el("order").getAttribute("tabindex"), el("tabbed").getAttribute("tabindex")]).toEqual(["0", "-1"]);
  let pageHeard = 0;
  const pageKeys = () => { pageHeard += 1; };
  p.frame.document.addEventListener("keydown", pageKeys as never);
  const enter = new p.frame.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  el("order").dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(true);
  expect(p.sent.filter((m) => m.type === "mandate.page.quote").map((m) => m.text)).toEqual(["Order #12 waits for your review"]);
  const esc = new p.frame.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  p.frame.document.body.dispatchEvent(esc);
  expect(esc.defaultPrevented).toBe(true);
  expect(p.sent.filter((m) => m.type === "mandate.page.quoteEnd")).toStrictEqual([{ type: "mandate.page.quoteEnd", pageId: PAGE }]);
  expect(pageHeard).toBe(0);
  p.fromHost({ type: "mandate.page.quoting", on: false });
  expect([el("order").hasAttribute("tabindex"), el("tabbed").getAttribute("tabindex")]).toEqual([false, "-1"]);
  p.frame.document.removeEventListener("keydown", pageKeys as never);
  p.close();
});

test("the host takes a page's quote folded to one line of at most 500 characters, and its other quoting messages", () => {
  const read = (data: Record<string, unknown>) => readPageFrameMessage({ ...data, pageId: PAGE }, PAGE);
  expect(read({ type: "mandate.page.quotable", any: true })).toEqual({ type: "quotable", any: true });
  expect(read({ type: "mandate.page.quotable", any: "yes" })).toBeNull();
  expect(read({ type: "mandate.page.quoteEnd" })).toEqual({ type: "quoteEnd" });
  expect(read({ type: "mandate.page.quote", text: "  Order  #12\n\n waits \t" })).toEqual({ type: "quote", text: "Order #12 waits" });
  // Cut by characters, never inside one.
  const long = read({ type: "mandate.page.quote", text: "😀".repeat(600) }) as { text: string };
  expect(Array.from(long.text)).toHaveLength(500);
  expect(long.text).toBe("😀".repeat(500));
  for (const text of ["", "  \n ", 42, null]) expect(read({ type: "mandate.page.quote", text })).toBeNull();
});

test("the page says whether it has an item to quote once its document is read, before its last script loads", () => {
  const p = pageWindow('<div data-quote="x">x</div>');
  p.frame.document.dispatchEvent(new p.frame.Event("DOMContentLoaded"));
  expect(p.sent.filter((m) => m.type === "mandate.page.quotable").map((m) => m.any)).toEqual([true]);
  // Its load says nothing new.
  p.frame.dispatchEvent(new p.frame.Event("load"));
  expect(p.sent.filter((m) => m.type === "mandate.page.quotable").map((m) => m.any)).toEqual([true]);
  p.close();
});

test("an item the page draws again while quoting is a tab stop too", async () => {
  const p = pageWindow('<div id="list"><div id="old" data-quote="Old">old</div></div>');
  p.fromHost({ type: "mandate.page.quoting", on: true });
  const list = p.frame.document.getElementById("list")!;
  list.innerHTML = '<div id="new" data-quote="New">new</div><div id="own" data-quote="Own" tabindex="-1">own</div>';
  await tick();
  const el = (id: string) => p.frame.document.getElementById(id)!;
  expect([el("new").getAttribute("tabindex"), el("own").getAttribute("tabindex")]).toEqual(["0", "-1"]);
  p.fromHost({ type: "mandate.page.quoting", on: false });
  expect([el("new").hasAttribute("tabindex"), el("own").getAttribute("tabindex")]).toEqual([false, "-1"]);
  // Drawn after the mode ended: no tab stop.
  list.insertAdjacentHTML("beforeend", '<div id="later" data-quote="Later">later</div>');
  await tick();
  expect(el("later").hasAttribute("tabindex")).toBe(false);
  p.close();
});

test("asked by the host, the page says again whether it has an item to quote, though nothing changed", () => {
  const p = pageWindow('<div data-quote="x">x</div>');
  p.frame.dispatchEvent(new p.frame.Event("load"));
  p.fromHost({ type: "mandate.page.askQuotable" });
  expect(p.sent.filter((m) => m.type === "mandate.page.quotable").map((m) => m.any)).toEqual([true, true]);
  p.close();
});

test("the page asks for what the user typed once its document is read, before its pictures and fonts load", () => {
  const p = pageWindow('<input id="a">');
  expect(p.sent.some((m) => m.type === "mandate.page.ready")).toBe(false);
  p.frame.document.dispatchEvent(new p.frame.Event("DOMContentLoaded"));
  expect(p.sent.filter((m) => m.type === "mandate.page.ready")).toHaveLength(1);
  // Its load asks nothing: the host gives the fields back on load as well.
  p.frame.dispatchEvent(new p.frame.Event("load"));
  expect(p.sent.filter((m) => m.type === "mandate.page.ready")).toHaveLength(1);
  expect(readPageFrameMessage({ type: "mandate.page.ready", pageId: PAGE }, PAGE)).toEqual({ type: "ready" });
  p.close();
});

test("asked to say once it has drawn, the page says so after its next paint, not before", () => {
  const p = pageWindow("<p>Orders</p>");
  const frames: Array<() => void> = [];
  (p.frame as unknown as { requestAnimationFrame: (fn: () => void) => number }).requestAnimationFrame = (fn) => frames.push(fn);
  const said = () => p.sent.filter((m) => m.type === "mandate.page.drawn");
  p.fromHost({ type: "mandate.page.whenDrawn" });
  // The frame before the paint; the one after it is when it was drawn.
  expect([frames.length, said().length]).toEqual([1, 0]);
  frames.shift()!();
  expect([frames.length, said().length]).toEqual([1, 0]);
  frames.shift()!();
  expect(said()).toStrictEqual([{ type: "mandate.page.drawn", pageId: PAGE }]);
  expect(readPageFrameMessage({ type: "mandate.page.drawn", pageId: PAGE }, PAGE)).toEqual({ type: "drawn" });
  p.close();
});

/** The frame's animation frames, run by hand. */
function framesOf(p: ReturnType<typeof pageWindow>) {
  const frames: Array<() => void> = [];
  (p.frame as unknown as { requestAnimationFrame: (fn: () => void) => number }).requestAnimationFrame = (fn) => frames.push(fn);
  const runAll = () => { while (frames.length > 0) frames.shift()!(); };
  return { frames, runAll };
}

test("asked to say it has drawn, the page first waits for the gets it made and the data of every source it follows", async () => {
  const p = pageWindow();
  const f = framesOf(p);
  const said = () => p.sent.filter((m) => m.type === "mandate.page.drawn").length;
  p.mandate.onData("threads", () => {});
  const got = p.mandate.data("tasks");
  const reqId = p.sent.find((m) => m.type === "mandate.page.get")!.reqId;
  p.fromHost({ type: "mandate.page.whenDrawn" });
  f.runAll();
  expect(said()).toBe(0);
  p.fromHost({ type: "mandate.page.data", name: "threads", data: { value: [], at: null, error: null } });
  f.runAll();
  expect(said()).toBe(0);
  p.fromHost({ type: "mandate.page.result", reqId, ok: true, data: { value: [], at: null, error: null } });
  await got;
  f.runAll();
  expect(said()).toBe(1);
  p.close();
});

test("a get or a source the page starts while it waits for its paint holds it until that has come too", async () => {
  const p = pageWindow();
  const f = framesOf(p);
  const said = () => p.sent.filter((m) => m.type === "mandate.page.drawn").length;
  p.fromHost({ type: "mandate.page.whenDrawn" });
  f.frames.shift()!();
  // An async helper's second read, and a subscription, during the wait.
  const got = p.mandate.data("tasks");
  p.mandate.onData("threads", () => {});
  f.runAll();
  expect(said()).toBe(0);
  const reqId = p.sent.find((m) => m.type === "mandate.page.get")!.reqId;
  p.fromHost({ type: "mandate.page.result", reqId, ok: true, data: { value: [], at: null, error: null } });
  await got;
  f.runAll();
  expect(said()).toBe(0);
  p.fromHost({ type: "mandate.page.data", name: "threads", data: { value: [], at: null, error: null } });
  f.runAll();
  expect(said()).toBe(1);
  p.close();
});

test("data that comes in while the page waits for its paint: it says it has drawn only after a paint with nothing new", () => {
  const p = pageWindow();
  const f = framesOf(p);
  const said = () => p.sent.filter((m) => m.type === "mandate.page.drawn").length;
  p.mandate.onData("threads", () => {});
  p.fromHost({ type: "mandate.page.data", name: "threads", data: { value: [1], at: null, error: null } });
  p.fromHost({ type: "mandate.page.whenDrawn" });
  f.frames.shift()!();
  // Between the paint and the frame after it: drawn at the paint after that.
  p.fromHost({ type: "mandate.page.data", name: "threads", data: { value: [2], at: null, error: null } });
  f.frames.shift()!();
  expect(said()).toBe(0);
  f.runAll();
  expect(said()).toBe(1);
  // Asked again (its load): said again, once.
  p.fromHost({ type: "mandate.page.whenDrawn" });
  f.runAll();
  expect(said()).toBe(2);
  p.close();
});

test("once the document is read the held values show in its fields, and decide nothing: the load's restore settles each field as before", async () => {
  const p = pageWindow('<input id="who"><input id="ok" type="checkbox"><form id="f"><input type="radio" name="env" id="prod"><input type="radio" name="env" id="dev"></form>');
  const doc = p.frame.document;
  const el = (id: string) => doc.getElementById(id) as unknown as HTMLInputElement;
  const env = "\u0000radio\u0000#f\u0000env";
  const held = { who: "gardener", ok: "true", [env]: "dev" };
  p.fromHost({ type: "mandate.page.preview", values: held });
  expect([el("who").value, el("ok").checked, el("dev").checked]).toEqual(["gardener", true, true]);
  // Shown, not kept: nothing went to the host.
  expect(p.sent.some((m) => m.type === "mandate.page.fields")).toBe(false);
  // The page fills the fields from its data before its load.
  el("who").value = "from data";
  el("ok").checked = false;
  el("prod").checked = true;
  // The load's restore gives them all back, as when it was the only one.
  p.fromHost({ type: "mandate.page.restore", values: held });
  expect([el("who").value, el("ok").checked, el("dev").checked, el("prod").checked]).toEqual(["gardener", true, true, false]);
  // A preview after it changes nothing.
  el("who").value = "page later";
  p.fromHost({ type: "mandate.page.preview", values: held });
  expect(el("who").value).toBe("page later");
  p.close();
});

test("a field drawn before the load's restore shows its held value; one the user typed in keeps what they typed", async () => {
  const p = pageWindow('<div id="form"></div>');
  const doc = p.frame.document;
  p.fromHost({ type: "mandate.page.preview", values: { who: "gardener", note: "old" } });
  doc.getElementById("form")!.innerHTML = '<input id="who"><input id="note">';
  await tick();
  const el = (id: string) => doc.getElementById(id) as unknown as HTMLInputElement;
  expect([el("who").value, el("note").value]).toEqual(["gardener", "old"]);
  el("note").value = "old, and more";
  el("note").dispatchEvent(new p.frame.Event("input", { bubbles: true }) as unknown as Event);
  p.fromHost({ type: "mandate.page.restore", values: { who: "gardener", note: "old" } });
  expect([el("who").value, el("note").value]).toEqual(["gardener", "old, and more"]);
  p.close();
});

test("a select whose options the page swaps for a placeholder over its load, and a radio choice with no member drawn, settle as before", async () => {
  const p = pageWindow('<select id="pick"><option value="a">A</option><option value="b">B</option></select><form id="f"><input type="radio" name="env" id="prod"></form>');
  const doc = p.frame.document;
  const pick = () => doc.getElementById("pick") as unknown as HTMLSelectElement;
  const env = "\u0000radio\u0000#f\u0000env";
  const held = { pick: "b", [env]: "" };
  p.fromHost({ type: "mandate.page.preview", values: held });
  expect(pick().value).toBe("b");
  // The page refreshes the options: a placeholder until they come.
  pick().innerHTML = '<option value="">Loading…</option>';
  // The page's data checks a member of the group the user left with none picked.
  (doc.getElementById("prod") as unknown as HTMLInputElement).checked = true;
  p.fromHost({ type: "mandate.page.restore", values: held });
  expect((doc.getElementById("prod") as unknown as HTMLInputElement).checked).toBe(false);
  // Its options come after the load: the held one is picked then.
  pick().innerHTML = '<option value="a">A</option><option value="b">B</option>';
  await tick();
  expect(pick().value).toBe("b");
  p.close();
});

test("typing in one field before the load's restore keeps the held values of the others", () => {
  const p = pageWindow('<input id="who"><input id="note">');
  const el = (id: string) => p.frame.document.getElementById(id) as unknown as HTMLInputElement;
  p.fromHost({ type: "mandate.page.preview", values: { who: "gardener", note: "old" } });
  el("note").value = "old, and more";
  el("note").dispatchEvent(new p.frame.Event("input", { bubbles: true }) as unknown as Event);
  expect(p.sent.filter((m) => m.type === "mandate.page.fields").at(-1)?.values).toEqual({ who: "gardener", note: "old, and more" });
  p.close();
});

test("an answer sent before the load's restore lets go of the values shown too", async () => {
  const p = pageWindow('<input id="who">');
  p.fromHost({ type: "mandate.page.preview", values: { who: "gardener" } });
  const sending = p.mandate.submit({ pick: "c" });
  const reqId = p.sent.find((m) => m.type === "mandate.page.submit")!.reqId;
  p.fromHost({ type: "mandate.page.result", reqId, ok: true });
  await sending;
  expect(p.sent.filter((m) => m.type === "mandate.page.fields").at(-1)?.values).toEqual({});
  p.close();
});

test("a preview that comes after the user picked in a radio group leaves their pick", () => {
  const p = pageWindow('<form id="f"><input type="radio" name="env" id="prod"><input type="radio" name="env" id="dev"></form>');
  const el = (id: string) => p.frame.document.getElementById(id) as unknown as HTMLInputElement;
  const env = "\u0000radio\u0000#f\u0000env";
  // The user picks dev before the preview of the last version's pick arrives.
  el("dev").checked = true;
  el("dev").dispatchEvent(new p.frame.Event("change", { bubbles: true }) as unknown as Event);
  p.fromHost({ type: "mandate.page.preview", values: { [env]: "prod" } });
  expect([el("dev").checked, el("prod").checked]).toEqual([true, false]);
  p.close();
});
