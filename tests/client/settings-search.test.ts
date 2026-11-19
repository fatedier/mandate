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
    // provider, so their hits land on the list, not on a guess. And the
    // default route's model, effort and fallbacks, which land on its row.
    const anchors = SETTINGS_SEARCH_INDEX.map((e) => e.anchor).filter((a) => a && a !== "providers" && a !== "route-default");
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

  test("the tool-call review is found on General by review, approval and rules; its two routes on Routing", () => {
    const hits = (query: string) => searchSettings(query, { desktop: false }).map((r) => [r.section, r.anchor ?? null, r.label]);
    expect(hits("review")).toContainEqual(["general", "tool-call-review", "Review tool calls"]);
    expect(hits("approval")).toContainEqual(["general", "tool-call-review", "Review tool calls"]);
    expect(hits("your rules")).toContainEqual(["general", "tool-call-review", "Review tool calls"]);
    expect(hits("second look")).toContainEqual(["routing", "route-toolReviewSecondLook", "Tool-call review: second look route"]);
    expect(hits("screen")).toContainEqual(["routing", "route-toolReviewScreen", "Tool-call review: screen route"]);
  });

  test("the skill review's route is found by skill, review and learned", () => {
    const routing = (query: string) => searchSettings(query, { desktop: false }).filter((r) => r.section === "routing").map((r) => [r.anchor, r.label]);
    for (const query of ["skill review", "learned skills", "write skills"]) expect(routing(query)).toContainEqual(["route-skillReview", "Skill review route"]);
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

  test("the chat history limit is found on General by limit, size and what passing it does", () => {
    const hits = (query: string) => searchSettings(query, { desktop: false }).map((r) => [r.section, r.anchor, r.label]);
    for (const query of ["chat history limit", "retention", "shorten tool outputs"]) {
      expect(hits(query)).toContainEqual(["general", "chat-history-limit", "Chat history limit"]);
    }
  });

  test("the agent's name is found as the personal agent, and still by the word global", () => {
    const hit = (query: string) => searchSettings(query, { desktop: false }).filter((r) => r.anchor === "personal-agent-name").map((r) => [r.group, r.label]);
    expect(hit("agent")).toEqual([["Personal agent", "Personal agent's name"]]);
    expect(hit("global")).toEqual([["Personal agent", "Personal agent's name"]]);
  });

  // "model" found the default route's model but not the Manager's or the
  // Workers' own, nor the fallbacks.
  test("model finds every route's model, the fallbacks among them", () => {
    const labels = searchSettings("model", { desktop: true }).map((r) => r.label);
    for (const label of ["Model", "Fallbacks", "Personal agent route", "Manager route", "Worker route"]) expect(labels).toContain(label);
  });

  test("every section is reachable from search", () => {
    const covered = new Set(SETTINGS_SEARCH_INDEX.map((e) => e.section));
    for (const id of SETTINGS_SECTION_IDS) expect(covered.has(id)).toBe(true);
  });

  test("settings search finds Decisions, Manager request check and Manager stop check in Routing", () => {
    expect(searchSettings("memory repeat check", { desktop: true }).map((entry) => [entry.section, entry.group])[0]).toEqual(["routing", "Memory repeat check"]);
    expect(searchSettings("manager stop check", { desktop: true }).map((entry) => [entry.section, entry.group])[0]).toEqual(["routing", "Manager stop check"]);
    expect(searchSettings("manager request check", { desktop: true }).map((entry) => [entry.section, entry.group])[0]).toEqual(["routing", "Manager request check"]);
    expect(searchSettings("decisions", { desktop: true }).map((entry) => [entry.section, entry.group])[0]).toEqual(["routing", "Decisions"]);
  });

  test("settings search finds billing, a model's price and price updates", () => {
    expect(searchSettings("billing").map((r) => r.label)).toContain("Billing");
    expect(searchSettings("price").map((r) => r.label)).toEqual(expect.arrayContaining(["Price", "Update prices automatically"]));
  });
});

describe("searchSettings", () => {
  test("an empty or whitespace query matches nothing", () => {
    expect(searchSettings("", { desktop: true })).toEqual([]);
    expect(searchSettings("   ", { desktop: true })).toEqual([]);
  });

  test("a label prefix outranks a mid-label hit, which outranks a keywords-only hit", () => {
    // In the opposite order here: equal scores keep the index order, so a
    // fixture already in the expected order could not tell a sort from none.
    const custom = index([
      { label: "Model", group: "Route", keywords: "reasoning" },
      { label: "Default reasoning", group: "Route" },
      { label: "Reasoning effort", group: "Route" }
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
