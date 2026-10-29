import { describe, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import type { MemoryEntryDto, MemoryStatsResponse } from "@shared/api-contracts";
import { BrowseView } from "@/routes/memory/BrowseView";
import { DEFAULT_FILTERS } from "@/routes/memory/memory-filters";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";

/** Memory's Browse view (BrowseView): its filters, how a row reads a
 *  memory's markdown, and how it names a memory's project. */

/** The stats Browse is given, empty unless a test says otherwise. Browse
 *  reads only byProject and projectNames; the counts match each test's
 *  memories. */
function memoryStats(over: Partial<MemoryStatsResponse> = {}): MemoryStatsResponse {
  return {
    totals: { available: 0, archived: 0, total: 0 },
    byScope: { user: 0, project: 0 },
    byType: { preference: 0, knowledge: 0 },
    bySource: { user: 0, agent: 0, extraction: 0 },
    byProject: [],
    projectNames: {},
    ...over
  };
}

/** Browse's filters on a narrow screen: the four selects keep to
 *  one row that scrolls sideways and fades on the side that has more, and the
 *  search takes a full row of its own. The layout itself is the e2e's
 *  (memory-browse-filters); happy-dom lays nothing out. */
describe("filters", () => {
  const stats = memoryStats();

  test("narrow, the filters are one row that scrolls sideways and says which side has more; the search fills its own row", async () => {
    mockFetch(() => Response.json({ entries: [], total: 0 }));
    const { host } = await mountAsync(
      <MemoryRouter>
        <BrowseView filters={DEFAULT_FILTERS} setFilters={() => {}} stats={stats} />
      </MemoryRouter>
    );
    await settle(20);
    const row = host.querySelector<HTMLElement>('[data-slot="memory-filters"]')!;
    expect(row.querySelectorAll('[data-slot="select-trigger"]').length).toBe(4);
    const classes = row.className.split(/\s+/);
    for (const name of ["fade-x-edges", "@max-[34rem]:flex-nowrap", "@max-[34rem]:overflow-x-auto"]) expect(classes).toContain(name);
    expect(row.getAttribute("data-more")).toBe(null);

    // A 390px phone: the row is 358px wide, its selects 720px.
    let left = 0;
    Object.defineProperty(row, "clientWidth", { configurable: true, get: () => 358 });
    Object.defineProperty(row, "scrollWidth", { configurable: true, get: () => 720 });
    Object.defineProperty(row, "scrollLeft", { configurable: true, get: () => left });
    const scrollTo = async (x: number) => {
      left = x;
      await act(async () => { row.dispatchEvent(new window.Event("scroll")); });
    };
    await scrollTo(0);
    expect(row.getAttribute("data-more")).toBe("right");
    await scrollTo(100);
    expect(row.getAttribute("data-more")).toBe("both");
    await scrollTo(362);
    expect(row.getAttribute("data-more")).toBe("left");

    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search memories"]')!;
    expect(search.className.split(/\s+/)).toContain("@max-[34rem]:w-full");
    expect(search.closest("form")!.className.split(/\s+/)).toContain("@max-[34rem]:ml-0");
  });

  // A select reached by keyboard in the scrolling row comes clear of the edge
  // fades, ring and all, as a tab row's pill does; one focused by a tap stays
  // where it is, so it does not move from under the finger.
  test("narrow, a select reached by keyboard is scrolled clear of the fade; one focused by a tap is left where it is", async () => {
    mockFetch(() => Response.json({ entries: [], total: 0 }));
    const { host } = await mountAsync(
      <MemoryRouter>
        <BrowseView filters={DEFAULT_FILTERS} setFilters={() => {}} stats={stats} />
      </MemoryRouter>
    );
    await settle(20);
    const row = host.querySelector<HTMLElement>('[data-slot="memory-filters"]')!;
    // A 390px phone: the row 358px wide, 4px of padding, then the four selects
    // 8px apart.
    let left = 0;
    Object.defineProperty(row, "clientWidth", { configurable: true, get: () => 358 });
    Object.defineProperty(row, "scrollWidth", { configurable: true, get: () => 608 });
    Object.defineProperty(row, "scrollLeft", { configurable: true, get: () => left, set: (x: number) => { left = x; } });
    const selects = [...row.querySelectorAll<HTMLElement>('[data-slot="select-trigger"]')];
    [[4, 144], [156, 128], [292, 144], [444, 160]].forEach(([offset, width], i) => {
      Object.defineProperty(selects[i]!, "offsetLeft", { configurable: true, get: () => offset });
      Object.defineProperty(selects[i]!, "offsetWidth", { configurable: true, get: () => width });
    });
    const focus = async (el: HTMLElement, keyboard: boolean) => {
      // happy-dom has no input modality: stand in for a keyboard focus.
      const realMatches = el.matches.bind(el);
      (el as unknown as { matches: (selector: string) => boolean }).matches = (selector) => (selector === ":focus-visible" ? keyboard : realMatches(selector));
      await act(async () => { el.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true })); });
    };
    // Source (292–436) runs under the right fade: scrolled until it ends 24px
    // inside the edge.
    await focus(selects[2]!, true);
    expect(left).toBe(436 - 358 + 24);
    // Sort tapped: it stays where it is.
    await focus(selects[3]!, false);
    expect(left).toBe(102);
    // Back to Scope by keyboard: the row returns to its start.
    await focus(selects[0]!, true);
    expect(left).toBe(0);
  });

  // Browse lists live memories only: an archived one is never
  // recalled and nothing can restore it; what the dream archived or forgot is
  // reviewed in Activity. No status choice, and every read asks for live ones,
  // even from an old link that said status=archived.
  test("Browse lists live memories only: no status choice, and it asks for live ones", async () => {
    const urls: string[] = [];
    mockFetch((call) => { urls.push(call.url); return Response.json({ entries: [], total: 0 }); });
    const { host } = await mountAsync(
      <MemoryRouter>
        <BrowseView filters={DEFAULT_FILTERS} setFilters={() => {}} stats={stats} />
      </MemoryRouter>
    );
    await settle(20);
    const labels = [...host.querySelectorAll('[data-slot="memory-filters"] [data-slot="select-trigger"]')].map((t) => t.getAttribute("aria-label"));
    expect(labels).not.toContain("Status");
    const reads = urls.filter((u) => u.includes("/api/memory/entries"));
    expect(reads.length).toBeGreaterThan(0);
    for (const u of reads) expect(new URL(u, "http://x").searchParams.get("status")).toBe("available");
  });
});

/** A Browse row reads a memory's markdown the way a brief does, inline:
 *  code in mono on its pill, no raw backticks. The row is a
 *  button, so a link is its text and blocks run together as one passage. */
describe("markdown", () => {
  const entry: MemoryEntryDto = {
    id: "mem_1", scope: "user", projectId: null, featureId: null, type: "preference", status: "available",
    content: "Run `bun run test`, *never* **bare** `bun test`; see [the gates](https://example.com/gates).\n\n- Typecheck first, ~~not last~~.",
    source: "user", userQuote: null, sourceThreadId: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", metadata: null
  };

  const stats = memoryStats({
    totals: { available: 1, archived: 0, total: 1 },
    byScope: { user: 1, project: 0 },
    byType: { preference: 1, knowledge: 0 },
    bySource: { user: 1, agent: 0, extraction: 0 }
  });

  test("a memory's row renders its markdown inline: code and emphasis, never a raw backtick, a link, or a block", async () => {
    mockFetch(() => Response.json({ entries: [entry], total: 1 }));
    const { host } = await mountAsync(
      <MemoryRouter>
        <BrowseView filters={DEFAULT_FILTERS} setFilters={() => {}} stats={stats} />
      </MemoryRouter>
    );
    const row = () => Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Typecheck first"));
    await settleUntil(() => row() !== undefined, "the memory's row");
    const content = row()!.querySelector(".line-clamp-2")!;
    expect(Array.from(content.querySelectorAll("code")).map((code) => code.textContent)).toEqual(["bun run test", "bun test"]);
    expect(content.querySelector("code")!.className).toContain("font-mono");
    expect(content.querySelector("strong")!.textContent).toBe("bare");
    expect(content.querySelector("em")!.textContent).toBe("never");
    expect(content.querySelector("del")!.textContent).toBe("not last");
    expect(content.textContent).not.toContain("`");
    expect(content.textContent).not.toContain("**");
    // Inside a button: the link is its words, and the list item continues the
    // passage after a space.
    expect(content.querySelector("a") === null).toBe(true);
    expect(content.querySelector("p, ul, li, div") === null).toBe(true);
    expect(content.textContent!.replace(/\s+/g, " ").trim()).toBe("Run bun run test, never bare bun test; see the gates. Typecheck first, not last.");
  });
});

/** Browse names a memory's project through the same lookup as Overview and
 *  Activity: an archived memory of a project with no live memory left is in
 *  the stats' projectNames, not in byProject. */
describe("project names", () => {
  const archived: MemoryEntryDto = {
    id: "mem_1", scope: "project", projectId: "proj_Ab3dEf6hIj9", featureId: null, type: "knowledge", status: "archived",
    content: "tagged from main", source: "extraction", userQuote: null, sourceThreadId: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", metadata: null
  };

  const stats = memoryStats({
    totals: { available: 0, archived: 1, total: 1 },
    projectNames: { proj_Ab3dEf6hIj9: "project-1" }
  });

  test("a row and its project chip read the project's name from the stats, not its id", async () => {
    mockFetch(() => Response.json({ entries: [archived], total: 1 }));
    const { host } = await mountAsync(
      <MemoryRouter>
        <BrowseView filters={{ ...DEFAULT_FILTERS, projectId: "proj_Ab3dEf6hIj9" }} setFilters={() => {}} stats={stats} />
      </MemoryRouter>
    );
    await settle(20);
    expect(host.textContent).toContain("tagged from main");
    expect(host.textContent).toContain("project-1");
    expect(host.textContent).not.toContain("proj_Ab3dEf6hIj9");
  });
});
