import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FILTERS,
  activeChips,
  entriesQuery,
  filtersFromParams,
  hasActiveFilters,
  paramsForFilters,
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
      params("usage=idle&scope=user&kind=preference&status=archived&sort=recalled&q=canvas&project=p1&feature=f1")
    );
    expect(f).toEqual({
      scope: "user",
      projectId: "p1",
      featureId: "f1",
      kind: "preference",
      status: "archived",
      usage: "idle",
      sort: "recalled",
      q: "canvas"
    });
  });

  test("an unrecognised value falls back rather than reaching the API", () => {
    const f = filtersFromParams(params("usage=nonsense&sort=;drop&scope=wat"));
    expect(f.usage).toBe("all");
    expect(f.sort).toBe("recent");
    expect(f.scope).toBe("all");
  });
});

describe("paramsForFilters", () => {
  test("defaults are omitted so the URL stays readable", () => {
    expect(paramsForFilters(params(""), DEFAULT_FILTERS).toString()).toBe("");
  });

  test("round-trips any set of filters", () => {
    const f = filters({ usage: "untouched", scope: "feature", kind: "semantic", q: "vue" });
    expect(filtersFromParams(paramsForFilters(params(""), f))).toEqual(f);
  });

  test("params this module does not own are carried through", () => {
    // `view` decides which tab is showing — losing it on every filter change
    // would bounce the user back to Overview mid-edit.
    const next = paramsForFilters(params("view=browse"), filters({ usage: "idle" }));
    expect(next.get("view")).toBe("browse");
    expect(next.get("usage")).toBe("idle");
  });

  test("returning a field to its default removes it from the URL", () => {
    const next = paramsForFilters(params("view=browse&usage=idle"), DEFAULT_FILTERS);
    expect(next.has("usage")).toBe(false);
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
    expect(q.has("usage")).toBe(false);
    expect(q.has("scope")).toBe(false);
  });

  test("passes the usage band and trims the search term", () => {
    const q = entriesQuery(filters({ usage: "idle", q: "  canvas  " }), { limit: 10, offset: 20 });
    expect(q.get("usage")).toBe("idle");
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
    const chips = activeChips(filters({ usage: "idle", projectId: "p1" }), { project: "frp" });
    expect(chips.map((c) => c.label)).toEqual(["recalled but never used", "frp"]);
  });

  test("sort and the query text are not chips", () => {
    // Sort narrows nothing, and the search box already displays its own term.
    expect(activeChips(filters({ sort: "recalled", q: "vue" }))).toEqual([]);
  });

  test("the default status is not a chip, a non-default one is", () => {
    expect(activeChips(filters({ status: "available" }))).toEqual([]);
    expect(activeChips(filters({ status: "archived" })).map((c) => c.label)).toEqual(["archived"]);
  });
});

describe("clearing", () => {
  test("dropping one chip leaves the others alone", () => {
    const f = filters({ usage: "idle", scope: "user", q: "canvas" });
    expect(withoutFilter(f, "usage")).toEqual(filters({ scope: "user", q: "canvas" }));
  });

  test("hasActiveFilters ignores nothing that narrows and nothing that doesn't", () => {
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    expect(hasActiveFilters(filters({ usage: "untouched" }))).toBe(true);
    expect(hasActiveFilters(filters({ q: "x" }))).toBe(true);
    // Sort is part of the view state and counts as active — clearing offers to
    // restore the default ordering too.
    expect(hasActiveFilters(filters({ sort: "recalled" }))).toBe(true);
  });
});
