import { describe, expect, it } from "bun:test";
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTION_IDS,
  paramForSection,
  sectionFromParam
} from "@/routes/settings/settings-nav";

describe("settings-nav", () => {
  it("maps current section params and defaults unknown params to General", () => {
    expect(sectionFromParam("providers")).toBe("providers");
    expect(sectionFromParam("ai")).toBe("general");
    expect(sectionFromParam("general")).toBe("general");
    expect(sectionFromParam(null)).toBe("general");
    expect(sectionFromParam("nonsense")).toBe("general");
  });

  it("omits the param for the default section", () => {
    expect(paramForSection("general")).toBeNull();
    expect(paramForSection("routing")).toBe("routing");
  });

  it("groups cover every section exactly once", () => {
    const ids = SETTINGS_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    expect([...ids].sort()).toEqual([...SETTINGS_SECTION_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
