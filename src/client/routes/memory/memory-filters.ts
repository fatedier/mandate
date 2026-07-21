import {
  MEMORY_ENTRY_SORTS,
  MEMORY_USAGE_FILTERS,
  type MemoryEntrySort,
  type MemoryUsageFilter
} from "@shared/api-contracts";
import { readEnum, withParam } from "@/lib/url-params";

export const SCOPE_FILTERS = ["all", "user", "global", "project", "feature"] as const;
export const KIND_FILTERS = ["all", "episodic", "semantic", "preference", "procedural"] as const;
export const STATUS_FILTERS = ["available", "archived", "all"] as const;

export type ScopeFilter = (typeof SCOPE_FILTERS)[number];
export type KindFilter = (typeof KIND_FILTERS)[number];
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export type MemoryFilters = {
  scope: ScopeFilter;
  projectId: string;
  featureId: string;
  kind: KindFilter;
  status: StatusFilter;
  usage: MemoryUsageFilter;
  sort: MemoryEntrySort;
  q: string;
};

export const DEFAULT_FILTERS: MemoryFilters = {
  scope: "all",
  projectId: "",
  featureId: "",
  kind: "all",
  status: "available",
  usage: "all",
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
    featureId: params.get("feature") ?? "",
    kind: readEnum(params, "kind", KIND_FILTERS, DEFAULT_FILTERS.kind),
    status: readEnum(params, "status", STATUS_FILTERS, DEFAULT_FILTERS.status),
    usage: readEnum(params, "usage", MEMORY_USAGE_FILTERS, DEFAULT_FILTERS.usage),
    sort: readEnum(params, "sort", MEMORY_ENTRY_SORTS, DEFAULT_FILTERS.sort),
    q: params.get("q") ?? ""
  };
}

const PARAM_KEYS: Array<[keyof MemoryFilters, string]> = [
  ["scope", "scope"],
  ["projectId", "project"],
  ["featureId", "feature"],
  ["kind", "kind"],
  ["status", "status"],
  ["usage", "usage"],
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
  if (filters.featureId) params.set("featureId", filters.featureId);
  if (filters.kind !== "all") params.set("kind", filters.kind);
  params.set("status", filters.status);
  if (filters.usage !== "all") params.set("usage", filters.usage);
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

export type FilterChip = { key: keyof MemoryFilters; label: string };

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
  names: { project?: string; feature?: string } = {}
): FilterChip[] {
  const chips: FilterChip[] = [];
  if (filters.usage !== "all") chips.push({ key: "usage", label: USAGE_LABEL[filters.usage] });
  if (filters.scope !== "all") chips.push({ key: "scope", label: `${filters.scope} scope` });
  if (filters.projectId) {
    chips.push({ key: "projectId", label: names.project ?? filters.projectId });
  }
  if (filters.featureId) {
    chips.push({ key: "featureId", label: names.feature ?? filters.featureId });
  }
  if (filters.kind !== "all") chips.push({ key: "kind", label: filters.kind });
  if (filters.status !== DEFAULT_FILTERS.status) {
    chips.push({ key: "status", label: filters.status });
  }
  return chips;
}

export const USAGE_LABEL: Record<MemoryUsageFilter, string> = {
  all: "any usage",
  used: "used at least once",
  idle: "recalled but never used",
  untouched: "never recalled"
};

export const SORT_LABEL: Record<MemoryEntrySort, string> = {
  recent: "Recently updated",
  used: "Most used",
  recalled: "Most recalled",
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
