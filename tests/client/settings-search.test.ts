import { describe, expect, test } from "bun:test";
import { SETTINGS_SECTION_IDS } from "@/routes/settings/settings-nav";
import {
  SETTINGS_SEARCH_INDEX,
  searchSettings,
  type SettingsSearchEntry
} from "@/routes/settings/settings-search";

const index = (entries: Partial<SettingsSearchEntry>[]): SettingsSearchEntry[] =>
  entries.map((entry) => ({
    section: "general",
    group: "Group",
    label: "Label",
    ...entry
  })) as SettingsSearchEntry[];

describe("settings search index", () => {
  test("every entry points at a real section", () => {
    const valid = new Set<string>(SETTINGS_SECTION_IDS);
    for (const entry of SETTINGS_SEARCH_INDEX) {
      expect(valid.has(entry.section)).toBe(true);
    }
  });

  test("anchors are unique — two rows sharing one id would make the jump ambiguous", () => {
    // Except the provider list: API key, Base URL and the rest exist once per
    // provider, so their hits land on the list, not on a guess.
    const anchors = SETTINGS_SEARCH_INDEX.map((e) => e.anchor).filter((a) => a && a !== "providers");
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  test("every provider setting lands on the provider list; the Prices switch, there once, on its own row", () => {
    const providers = SETTINGS_SEARCH_INDEX.filter((e) => e.section === "providers" && e.group === "Providers");
    expect(providers.length).toBeGreaterThan(1);
    for (const entry of providers) expect(entry.anchor).toBe("providers");
    expect(SETTINGS_SEARCH_INDEX.filter((e) => e.section === "providers" && e.group !== "Providers").map((e) => e.anchor)).toStrictEqual(["prices"]);
  });

  test("the dream's and memory extraction's routes are found on Routing", () => {
    const routing = (query: string) => searchSettings(query, { desktop: false }).filter((r) => r.section === "routing").map((r) => r.label);
    expect(routing("dream")).toContain("Dream route");
    expect(routing("extraction")).toContain("Memory extraction route");
    expect(routing("remember")).toContain("Memory extraction route");
  });

  test("the subagent route is found on Routing, also by the words background and job", () => {
    const routing = (query: string) => searchSettings(query, { desktop: false }).filter((r) => r.section === "routing").map((r) => r.label);
    expect(routing("subagent")).toContain("Subagent route");
    expect(routing("background")).toContain("Subagent route");
    expect(routing("job")).toContain("Subagent route");
  });

  // Idle compaction: both its settings are found by the words someone would
  // type.
  test("idle compaction is found on General, each model's cache lifetime on the provider list", () => {
    const hits = (query: string) => searchSettings(query, { desktop: false }).map((r) => [r.section, r.anchor, r.label]);
    expect(hits("idle")).toContainEqual(["general", "idle-compaction", "Compact idle threads"]);
    expect(hits("compaction")).toContainEqual(["general", "idle-compaction", "Compact idle threads"]);
    expect(hits("cache")).toContainEqual(["general", "idle-compaction", "Compact idle threads"]);
    expect(hits("cache")).toContainEqual(["providers", "providers", "Cache lifetime"]);
    expect(hits("ttl")).toContainEqual(["providers", "providers", "Cache lifetime"]);
  });

  test("the agent's name is found as Your agent, and still by the word global", () => {
    const hit = (query: string) => searchSettings(query, { desktop: false }).filter((r) => r.anchor === "global-agent-name").map((r) => [r.group, r.label]);
    expect(hit("agent")).toEqual([["Your agent", "Your agent's name"]]);
    expect(hit("global")).toEqual([["Your agent", "Your agent's name"]]);
  });

  // "model" found the default route's model but not the Manager's or the
  // Workers' own, nor the fallbacks.
  test("model finds every route's model, the fallbacks among them", () => {
    const labels = searchSettings("model", { desktop: true }).map((r) => r.label);
    for (const label of ["Model", "Fallbacks", "Your agent route", "Manager route", "Worker route"]) expect(labels).toContain(label);
  });

  test("every section is reachable from search", () => {
    const covered = new Set(SETTINGS_SEARCH_INDEX.map((e) => e.section));
    for (const id of SETTINGS_SECTION_IDS) expect(covered.has(id)).toBe(true);
  });
});

describe("searchSettings", () => {
  test("an empty or whitespace query matches nothing", () => {
    expect(searchSettings("", { desktop: true })).toEqual([]);
    expect(searchSettings("   ", { desktop: true })).toEqual([]);
  });

  test("a label prefix outranks a mid-label hit, which outranks a keywords-only hit", () => {
    const custom = index([
      { label: "Reasoning effort", group: "Route" },
      { label: "Default reasoning", group: "Route" },
      { label: "Model", group: "Route", keywords: "reasoning" }
    ]);
    const hits = searchSettings("reasoning", { desktop: true, index: custom });
    expect(hits.map((h) => h.label)).toEqual([
      "Reasoning effort",
      "Default reasoning",
      "Model"
    ]);
  });

  test("all terms must match — a query is an AND, not an OR", () => {
    const custom = index([
      { label: "Listen address", keywords: "host network" },
      { label: "Port", keywords: "host" }
    ]);
    expect(searchSettings("listen host", { desktop: true, index: custom })).toHaveLength(1);
    expect(searchSettings("listen nonsense", { desktop: true, index: custom })).toHaveLength(0);
  });

  test("desktop-only settings are hidden in the browser build", () => {
    const custom = index([
      { label: "Port", desktopOnly: true },
      { label: "Portable thing" }
    ]);
    expect(searchSettings("port", { desktop: false, index: custom }).map((h) => h.label)).toEqual([
      "Portable thing"
    ]);
    expect(searchSettings("port", { desktop: true, index: custom })).toHaveLength(2);
  });

  test("matching is case-insensitive and searches the group name too", () => {
    const custom = index([{ label: "Idle timeout", group: "Session" }]);
    expect(searchSettings("IDLE", { desktop: true, index: custom })).toHaveLength(1);
    expect(searchSettings("session", { desktop: true, index: custom })).toHaveLength(1);
  });

  test("equal scores keep the authored index order rather than reordering arbitrarily", () => {
    const custom = index([
      { label: "Alpha thing", keywords: "shared" },
      { label: "Beta thing", keywords: "shared" }
    ]);
    expect(searchSettings("shared", { desktop: true, index: custom }).map((h) => h.label)).toEqual([
      "Alpha thing",
      "Beta thing"
    ]);
  });

  test("regex metacharacters in a query are matched literally, not compiled", () => {
    const custom = index([{ label: "127.0.0.1 default", keywords: "host" }]);
    expect(() => searchSettings("(", { desktop: true, index: custom })).not.toThrow();
    expect(searchSettings("127.0.0.1", { desktop: true, index: custom })).toHaveLength(1);
    // "1x7" must not match via a dot wildcard.
    expect(searchSettings("1x7", { desktop: true, index: custom })).toHaveLength(0);
  });

  test("the real index resolves the questions it exists to answer", () => {
    const port = searchSettings("port", { desktop: true });
    expect(port[0]?.section).toBe("general");
    expect(port[0]?.anchor).toBe("web-port");

    const spoken = searchSettings("spoken language", { desktop: false });
    expect(spoken[0]?.section).toBe("voice");
    expect(spoken[0]?.anchor).toBe("voice-language");
  });

  test.each(["context", "compression", "threshold"])(
    "finds the compression control with %s",
    (query) => {
      expect(searchSettings(query, { desktop: false })[0]).toMatchObject({
        section: "general",
        anchor: "context-compression"
      });
    }
  );

  // The worker token budget is gone: no entry leads to a row
  // that is not there.
  test("nothing is found for the worker token budget", () => {
    expect(searchSettings("budget", { desktop: false }).map((r) => r.anchor)).not.toContain("worker-token-budget");
    expect(searchSettings("token", { desktop: false })[0]).toMatchObject({ section: "general", anchor: "context-compression" });
  });
});
