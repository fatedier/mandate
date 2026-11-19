import { MEMORY_ENTRY_SORTS, type MemoryEntrySort, type MemoryStatsResponse } from "@shared/api-contracts";
import { readEnum, withParam } from "@/lib/url-params";

export const SCOPE_FILTERS = ["all", "user", "project"] as const;
export const TYPE_FILTERS = ["all", "preference", "knowledge"] as const;
export const SOURCE_FILTERS = ["all", "user", "agent", "extraction"] as const;

export type ScopeFilter = (typeof SCOPE_FILTERS)[number];
export type TypeFilter = (typeof TYPE_FILTERS)[number];
export type SourceFilter = (typeof SOURCE_FILTERS)[number];

export type MemoryFilters = {
  scope: ScopeFilter;
  projectId: string;
  type: TypeFilter;
  source: SourceFilter;
  sort: MemoryEntrySort;
  q: string;
};

export const DEFAULT_FILTERS: MemoryFilters = {
  scope: "all",
  projectId: "",
  type: "all",
  source: "all",
  sort: "recent",
  q: ""
};

/**
 * Filters live in the URL, not in component state.
 *
 * The Overview is a dispatcher: every figure on it is a link into a filtered
 * Browse. That only works if a filtered Browse is addressable — otherwise the
 * doorways have nowhere to point, and a shared link loses whatever the sender
 * was looking at.
 */
export function filtersFromParams(params: URLSearchParams): MemoryFilters {
  return {
    scope: readEnum(params, "scope", SCOPE_FILTERS, DEFAULT_FILTERS.scope),
    projectId: params.get("project") ?? "",
    type: readEnum(params, "type", TYPE_FILTERS, DEFAULT_FILTERS.type),
    source: readEnum(params, "source", SOURCE_FILTERS, DEFAULT_FILTERS.source),
    sort: readEnum(params, "sort", MEMORY_ENTRY_SORTS, DEFAULT_FILTERS.sort),
    q: params.get("q") ?? ""
  };
}

const PARAM_KEYS: Array<[keyof MemoryFilters, string]> = [
  ["scope", "scope"],
  ["projectId", "project"],
  ["type", "type"],
  ["source", "source"],
  ["sort", "sort"],
  ["q", "q"]
];

/**
 * Write filters onto existing params, dropping anything at its default so the
 * URL stays readable. Params this module doesn't own — `view` above all — are
 * carried through untouched.
 */
export function paramsForFilters(
  base: URLSearchParams,
  filters: MemoryFilters
): URLSearchParams {
  let next = new URLSearchParams(base);
  for (const [field, key] of PARAM_KEYS) {
    const value = filters[field];
    next = withParam(next, key, value === DEFAULT_FILTERS[field] ? null : value);
  }
  return next;
}

/** Query string for the entries endpoint. Sends every value, defaults included —
 *  the server has its own defaults and shouldn't have to guess at omissions. */
export function entriesQuery(
  filters: MemoryFilters,
  page: { limit: number; offset: number }
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.scope !== "all") params.set("scope", filters.scope);
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.type !== "all") params.set("type", filters.type);
  if (filters.source !== "all") params.set("source", filters.source);
  // Live memories only: an archived one is never recalled and nothing can
  // restore it; what the dream archived or forgot is reviewed in Activity.
  // An old link's `status` param is ignored.
  params.set("status", "available");
  params.set("sort", filters.sort);
  if (filters.q.trim()) params.set("q", filters.q.trim());
  params.set("limit", String(page.limit));
  params.set("offset", String(page.offset));
  return params;
}

/**
 * Link target for a filtered Browse. This is what makes the Overview a
 * dispatcher rather than a dashboard — each figure is a real href, so it
 * middle-clicks, shares, and back-buttons like any other link.
 */
export function browseHref(over: Partial<MemoryFilters> = {}): string {
  const params = paramsForFilters(new URLSearchParams("view=browse"), {
    ...DEFAULT_FILTERS,
    ...over
  });
  return `/memory?${params.toString()}`;
}

type FilterChip = { key: keyof MemoryFilters; label: string };

/**
 * The filters currently narrowing the list, as dismissible chips.
 *
 * Sort and the free-text query are excluded: sort narrows nothing, and the
 * search box already shows its own term. A chip has to be something you would
 * otherwise not know was applied — which is exactly the case when Browse was
 * opened from an Overview doorway.
 */
export function activeChips(
  filters: MemoryFilters,
  names: { project?: string } = {}
): FilterChip[] {
  const chips: FilterChip[] = [];
  // A project names its own scope: one chip for it, not "project scope" too.
  if (filters.projectId) {
    chips.push({ key: "projectId", label: names.project ?? filters.projectId });
  } else if (filters.scope !== "all") {
    chips.push({ key: "scope", label: filters.scope === "user" ? "yours" : "any project" });
  }
  if (filters.type !== "all") chips.push({ key: "type", label: filters.type });
  if (filters.source !== "all") chips.push({ key: "source", label: SOURCE_CHIP[filters.source] });
  return chips;
}

const SOURCE_CHIP: Record<Exclude<SourceFilter, "all">, string> = {
  user: "said by you",
  agent: "agent",
  extraction: "extracted"
};

export const SORT_LABEL: Record<MemoryEntrySort, string> = {
  recent: "Recently updated",
  created: "Newest",
  oldest: "Oldest"
};

/** Clearing a chip restores that one field, leaving the rest of the view alone. */
export function withoutFilter(filters: MemoryFilters, key: keyof MemoryFilters): MemoryFilters {
  return { ...filters, [key]: DEFAULT_FILTERS[key] };
}

export function hasActiveFilters(filters: MemoryFilters): boolean {
  return PARAM_KEYS.some(([field]) => filters[field] !== DEFAULT_FILTERS[field]);
}

/** Browse's Scope choices: everywhere, the user's, any project, then each
 *  project with live memories, by name. Browse lists live memories only, and
 *  an archived project has none (they were archived with it; two archived
 *  projects of one name would be two identical choices). The project a link
 *  filtered to stays a choice, by its name if the stats know it, so the
 *  select is never blank. */
export function scopeOptions(
  stats: Pick<MemoryStatsResponse, "byProject" | "projectNames"> | null,
  projectId: string
): Array<{ value: string; label: string }> {
  const names = new Map<string, string>((stats?.byProject ?? []).map((project) => [project.projectId, project.name]));
  if (projectId && !names.has(projectId)) names.set(projectId, stats?.projectNames[projectId] ?? projectId);
  const projects = [...names].sort(([, a], [, b]) => a.localeCompare(b));
  return [
    { value: "all", label: "Everywhere" },
    { value: "user", label: "Yours" },
    { value: "project", label: "Any project" },
    ...projects.map(([id, name]) => ({ value: `project:${id}`, label: name }))
  ];
}
