import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType
 } from "react";
import { useSearchParams } from "react-router";
import { CornerDownLeft, Search, X } from "lucide-react";
import { Section } from "@/components/Section";
import { Button } from "@/components/ui/button";
import { withParam } from "@/lib/url-params";
import { isDesktopRuntime } from "@/lib/runtime";
import { useUiPageSummary } from "@/lib/ui-context";
import { GeneralPane } from "./GeneralPane";
import { MemoryPane } from "./MemoryPane";
import { ProvidersPane } from "./ProvidersPane";
import { RestartBanner } from "./RestartBanner";
import { RoutingPane } from "./RoutingPane";
import { SkillsPane } from "./SkillsPane";
import { VoicePane } from "./VoicePane";
import { useSettingsConfig } from "./settings-config";
import { SettingsConfigProvider } from "./SettingsConfigProvider";
import { 
  SETTINGS_NAV_GROUPS,
  paramForSection,
  sectionFromParam,
  type SettingsSectionId
 } from "./settings-nav";
import { searchSettings, type SettingsSearchResult } from "./settings-search";
import { PillTabs } from "@/components/PillTabs";
import { RefreshButton } from "@/components/RefreshButton";
import { useIsMobile } from "@/hooks/useIsMobile";
import { PaneHeaderActions } from "@/shell/pane-header-slots";
import { useUIStore } from "@/store/ui";

/**
 * One fixed frame, one content width, for every tab: switching sections must
 * not move the nav, the search bar, the page edges, or the content's right
 * edge. Per-pane widths (a narrower "form" measure vs a wider list cap) were
 * tried twice and rejected both times — the jump reads as breakage. Forms
 * cope with the width because SettingRow hangs controls off the right edge;
 * the gutter grows, the fields do not.
 */
type PaneSpec = { Component: ComponentType };

const FRAME_MAX = 880;

const PANES: Record<SettingsSectionId, PaneSpec> = {
  general: { Component: GeneralPane },
  providers: { Component: ProvidersPane },
  routing: { Component: RoutingPane },
  memory: { Component: MemoryPane },
  voice: { Component: VoicePane },
  skills: { Component: SkillsPane }
};

const FLASH_MS = 1400;
/** How long to keep looking for a jump target before giving up on it. */
const ANCHOR_WAIT_MS = 1000;

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const section = sectionFromParam(searchParams.get("tab"));
  const setSection = (next: SettingsSectionId) =>
    setSearchParams((prev) => withParam(prev, "tab", paramForSection(next)), { replace: true });
  useUiPageSummary("settings", () => ({ page: "settings", tab: section }));
  return (
    <SettingsConfigProvider>
      <SettingsSurface section={section} setSection={setSection} />
    </SettingsConfigProvider>
  );
}

/** Child of the provider so it can read the shared config store. */
function SettingsSurface({
  section,
  setSection
}: {
  section: SettingsSectionId;
  setSection: (next: SettingsSectionId) => void;
}) {
  const { config, loading, loadError, reload } = useSettingsConfig();
  // The section rail lives in the app sidebar. The in-page strip exists only
  // while that rail is gone — sidebar collapsed, or a phone, which has no
  // sidebar — never by pane width: at the 50/50 split the old <40rem rule
  // showed the rail and the strip together.
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const isMobile = useIsMobile();
  const showStrip = sidebarCollapsed || isMobile;
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingAnchorRef = useRef<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pane = PANES[section];
  const results = searchSettings(query, { desktop: isDesktopRuntime() });
  const searching = query.trim().length > 0;

  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    []
  );

  /**
   * Jump to a search hit. The target section may not be mounted yet, so the
   * anchor is parked and consumed by the effect below once the pane renders;
   * a hit inside the section already showing resolves on the same pass.
   */
  const openResult = useCallback(
    (result: SettingsSearchResult) => {
      setQuery("");
      pendingAnchorRef.current = result.anchor ?? null;
      if (result.section !== section) setSection(result.section);
    },
    [section, setSection]
  );

  /**
   * Wait for the row, then scroll to it and flash it.
   *
   * Poll per frame rather than assuming a fixed number of them: clearing the
   * request on a set frame consumed the anchor while the previous pane was
   * still mounted — the router's section change lands a render later than the
   * click that queued it — so the jump silently did nothing. The deadline
   * stops a stale anchor (a renamed row, a desktop-only setting in the
   * browser) from polling forever.
   */
  useEffect(() => {
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;
    let raf = 0;
    const deadline = performance.now() + ANCHOR_WAIT_MS;
    const attempt = () => {
      const el = document.getElementById(`setting-${anchor}`);
      if (!el) {
        if (performance.now() < deadline) raf = requestAnimationFrame(attempt);
        else pendingAnchorRef.current = null;
        return;
      }
      pendingAnchorRef.current = null;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.removeAttribute("data-setting-flash");
      // Force a reflow so re-flashing the same row restarts the animation.
      void el.offsetWidth;
      el.setAttribute("data-setting-flash", "");
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => el.removeAttribute("data-setting-flash"), FLASH_MS);
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  });

  // A pane switch should start at the top; without this the previous pane's
  // scroll offset carries over into a shorter one and lands mid-form.
  useEffect(() => {
    if (pendingAnchorRef.current) return;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [section]);

  return (
    <div
      className="mx-auto flex min-h-0 w-full flex-1 flex-col"
      style={{ maxWidth: FRAME_MAX }}
    >
      {/* Refresh is a header-band action, like every other page's. */}
      <PaneHeaderActions>
        <RefreshButton scope="local" what="settings" refreshing={loading} onRefresh={() => void reload()} size="icon-xs" />
      </PaneHeaderActions>
      {/* Fixed chrome: search, restart notice and load errors stay put; only
          the pane region below scrolls, so switching tabs never moves them. */}
      <div className="flex shrink-0 flex-col gap-3 px-6 pb-4 pt-2">
        <SettingsSearchBox
          query={query}
          results={results}
          onQueryChange={setQuery}
          onSelect={openResult}
        />
        <RestartBanner />
        {loadError && config ? (
          <div className="flex items-center gap-3 text-xs text-destructive">
            <span className="min-w-0">Refresh failed — showing last loaded settings: {loadError}</span>
            <button
              type="button"
              className="shrink-0 font-medium underline underline-offset-2 hover:opacity-80"
              onClick={() => void reload()}
            >
              Retry
            </button>
          </div>
        ) : null}
      </div>
      {loadError && !config ? (
        <div className="px-6 pb-6">
          <div className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3 text-sm text-destructive">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-6 pb-10 [scrollbar-gutter:stable]"
        >
          <div className="@container">
            <div className="flex min-w-0 flex-col gap-5">
              {showStrip && (
                <PillTabs
                  items={SETTINGS_NAV_GROUPS.flatMap((group) => group.items)}
                  value={section}
                  onChange={setSection}
                  aria-label="Settings sections"
                  role="nav"
                />
              )}
              {searching ? (
                <SearchResults results={results} onSelect={openResult} query={query} />
              ) : (
                <pane.Component />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The header row. Search carries it — previously a lone subtitle sat at the
 * far left and a lone refresh icon at the far right with 600px of nothing
 * between them, which reads as two orphans rather than a toolbar.
 */
function SettingsSearchBox({
  query,
  results,
  onQueryChange,
  onSelect
}: {
  query: string;
  results: SettingsSearchResult[];
  onQueryChange: (value: string) => void;
  onSelect: (result: SettingsSearchResult) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // "/" focuses search, the convention in every tool this page competes with.
  // Ignored while typing somewhere else so it can still be a literal slash.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex min-w-0 flex-1 items-center">
        <Search className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-chrome" aria-hidden />
        <input
          ref={inputRef}
          type="search"
          value={query}
          aria-label="Search settings"
          placeholder="Search settings…"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-9 text-sm outline-none placeholder:text-chrome focus:border-ring focus:ring-[3px] focus:ring-ring/20 [&::-webkit-search-cancel-button]:hidden"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onQueryChange("");
              inputRef.current?.blur();
            }
            if (event.key === "Enter" && results[0]) onSelect(results[0]);
          }}
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            className="absolute right-2.5 text-chrome hover:text-foreground"
            onClick={() => {
              onQueryChange("");
              inputRef.current?.focus();
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-2.5 rounded border border-border-soft px-1.5 text-2xs text-chrome">
            /
          </kbd>
        )}
      </div>
    </div>
  );
}

function SearchResults({
  results,
  query,
  onSelect
}: {
  results: SettingsSearchResult[];
  query: string;
  onSelect: (result: SettingsSearchResult) => void;
}) {
  if (results.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border-soft px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          No setting matches “<span className="text-foreground">{query}</span>”.
        </p>
        <p className="mt-1 text-xs text-chrome">Try the provider or model name instead.</p>
      </div>
    );
  }
  return (
    <Section
      title="Matches"
      meta={`${results.length} ${results.length === 1 ? "setting" : "settings"}`}
      trailing={
        <span className="inline-flex items-center gap-1 text-2xs text-faint">
          <CornerDownLeft className="size-3" aria-hidden />
          to open the first
        </span>
      }
    >
      <div className="divide-y divide-border-soft">
        {results.map((result, index) => (
          <button
            key={`${result.section}-${result.label}-${index}`}
            type="button"
            className="flex min-h-10 w-full items-center gap-3 px-3.5 py-1.5 text-left transition-colors hover:bg-sel"
            onClick={() => onSelect(result)}
          >
            <span className="min-w-0 flex-1 truncate text-sm">{result.label}</span>
            <span className="shrink-0 text-2xs text-chrome">
              {/* A section whose only group shares its name would read
                  "Providers · Providers". */}
              {sectionLabel(result.section) === result.group
                ? result.group
                : `${sectionLabel(result.section)} · ${result.group}`}
            </span>
          </button>
        ))}
      </div>
    </Section>
  );
}

function sectionLabel(id: SettingsSectionId): string {
  for (const group of SETTINGS_NAV_GROUPS) {
    for (const item of group.items) if (item.id === id) return item.label;
  }
  return id;
}

