import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FILTERS,
  activeChips,
  entriesQuery,
  filtersFromParams,
  hasActiveFilters,
  paramsForFilters,
  scopeOptions,
  withoutFilter,
  type MemoryFilters
} from "@/routes/memory/memory-filters";

const params = (s: string) => new URLSearchParams(s);
const filters = (over: Partial<MemoryFilters> = {}): MemoryFilters => ({
  ...DEFAULT_FILTERS,
  ...over
});

describe("filtersFromParams", () => {
  test("an empty URL is the default view", () => {
    expect(filtersFromParams(params(""))).toEqual(DEFAULT_FILTERS);
  });

  test("reads every field the Overview's doorways can set", () => {
    const f = filtersFromParams(
      params("type=preference&scope=user&source=user&sort=created&q=canvas&project=p1")
    );
    expect(f).toEqual({
      scope: "user",
      projectId: "p1",
      type: "preference",
      source: "user",
      sort: "created",
      q: "canvas"
    });
  });

  // Browse lists live memories only; an old link's status is not
  // a filter any more, and the read still asks for live ones.
  test("an old link's status=archived opens the live list", () => {
    const f = filtersFromParams(params("status=archived&type=knowledge"));
    expect(f).toEqual({ ...DEFAULT_FILTERS, type: "knowledge" });
    expect(entriesQuery(f, { limit: 50, offset: 0 }).get("status")).toBe("available");
    expect(activeChips(f).map((c) => c.label)).toEqual(["knowledge"]);
  });

  test("an unrecognised value falls back rather than reaching the API", () => {
    const f = filtersFromParams(params("type=nonsense&sort=;drop&scope=wat"));
    expect(f.type).toBe("all");
    expect(f.sort).toBe("recent");
    expect(f.scope).toBe("all");
  });
});

describe("paramsForFilters", () => {
  test("defaults are omitted so the URL stays readable", () => {
    expect(paramsForFilters(params(""), DEFAULT_FILTERS).toString()).toBe("");
  });

  test("round-trips any set of filters", () => {
    const f = filters({ type: "knowledge", scope: "project", q: "vue" });
    expect(filtersFromParams(paramsForFilters(params(""), f))).toEqual(f);
  });

  test("params this module does not own are carried through", () => {
    // `view` decides which tab is showing — losing it on every filter change
    // would bounce the user back to Overview mid-edit.
    const next = paramsForFilters(params("view=browse"), filters({ type: "knowledge" }));
    expect(next.get("view")).toBe("browse");
    expect(next.get("type")).toBe("knowledge");
  });

  test("the source filter is written to the URL and sent to the server", () => {
    const next = paramsForFilters(params("view=browse"), filters({ source: "user" }));
    expect(next.get("source")).toBe("user");
    expect(entriesQuery(filters({ source: "extraction" }), { limit: 50, offset: 0 }).get("source")).toBe("extraction");
    expect(entriesQuery(filters({}), { limit: 50, offset: 0 }).has("source")).toBe(false);
  });

  test("returning a field to its default removes it from the URL", () => {
    const next = paramsForFilters(params("view=browse&type=knowledge"), DEFAULT_FILTERS);
    expect(next.has("type")).toBe(false);
    expect(next.get("view")).toBe("browse");
  });
});

describe("entriesQuery", () => {
  test("omits defaults but always pins status, sort and the page", () => {
    const q = entriesQuery(DEFAULT_FILTERS, { limit: 50, offset: 0 });
    expect(q.get("status")).toBe("available");
    expect(q.get("sort")).toBe("recent");
    expect(q.get("limit")).toBe("50");
    expect(q.get("offset")).toBe("0");
    expect(q.has("type")).toBe(false);
    expect(q.has("scope")).toBe(false);
  });

  test("passes the type and trims the search term", () => {
    const q = entriesQuery(filters({ type: "knowledge", q: "  canvas  " }), { limit: 10, offset: 20 });
    expect(q.get("type")).toBe("knowledge");
    expect(q.get("q")).toBe("canvas");
    expect(q.get("offset")).toBe("20");
  });

  test("a whitespace-only search is not sent as a filter", () => {
    expect(entriesQuery(filters({ q: "   " }), { limit: 1, offset: 0 }).has("q")).toBe(false);
  });
});

describe("activeChips", () => {
  test("no chips on the default view", () => {
    expect(activeChips(DEFAULT_FILTERS)).toEqual([]);
  });

  test("shows what is narrowing the list, using names where known", () => {
    const chips = activeChips(filters({ type: "knowledge", projectId: "p1" }), { project: "project-1" });
    expect(chips.map((c) => c.label)).toEqual(["project-1", "knowledge"]);
  });

  test("sort and the query text are not chips", () => {
    // Sort narrows nothing, and the search box already displays its own term.
    expect(activeChips(filters({ sort: "created", q: "vue" }))).toEqual([]);
  });

});

describe("clearing", () => {
  test("dropping one chip leaves the others alone", () => {
    const f = filters({ type: "knowledge", scope: "user", q: "canvas" });
    expect(withoutFilter(f, "type")).toEqual(filters({ scope: "user", q: "canvas" }));
  });

  test("hasActiveFilters ignores nothing that narrows and nothing that doesn't", () => {
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    expect(hasActiveFilters(filters({ type: "knowledge" }))).toBe(true);
    expect(hasActiveFilters(filters({ q: "x" }))).toBe(true);
    // Sort is part of the view state and counts as active — clearing offers to
    // restore the default ordering too.
    expect(hasActiveFilters(filters({ sort: "created" }))).toBe(true);
  });
});

describe("scopeOptions", () => {
  // Browse lists live memories only, so a choice is a project with live ones;
  // an archived project has none (its memories went with it). The project a
  // link filtered to stays a choice, by name if the stats know it, so the
  // select is never blank.
  test("each project with live memories is a choice, by name, and the one a link filtered to", () => {
    const stats = {
      byProject: [{ projectId: "p_project3", name: "project-3", count: 1 }, { projectId: "p_project1", name: "project-1", count: 3 }],
      projectNames: { p_project1: "project-1", p_project2: "project-2", p_project3: "project-3" }
    };
    expect(scopeOptions(stats, "").map((o) => o.label)).toEqual(["Everywhere", "Yours", "Any project", "project-1", "project-3"]);
    expect(scopeOptions(stats, "p_project2").slice(3)).toEqual([
      { value: "project:p_project1", label: "project-1" },
      { value: "project:p_project2", label: "project-2" },
      { value: "project:p_project3", label: "project-3" }
    ]);
    expect(scopeOptions(stats, "p_gone").map((o) => o.value)).toContain("project:p_gone");
  });
});

// Task records left memory: a link that still says type=task filters nothing.
test("type=task in the address is no filter", () => {
  expect(filtersFromParams(new URLSearchParams("type=task")).type).toBe("all");
});
