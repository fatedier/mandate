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
    const anchors = SETTINGS_SEARCH_INDEX.map((e) => e.anchor).filter(Boolean);
    expect(new Set(anchors).size).toBe(anchors.length);
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

    const ptt = searchSettings("push to talk", { desktop: false });
    expect(ptt[0]?.section).toBe("voice");
    expect(ptt[0]?.anchor).toBe("voice-input-mode");
  });

  test.each(["context", "compression", "threshold", "token", "budget"])(
    "finds the compression control with %s",
    (query) => {
      expect(searchSettings(query, { desktop: false })[0]).toMatchObject({
        section: "general",
        anchor: "context-compression"
      });
    }
  );
});
