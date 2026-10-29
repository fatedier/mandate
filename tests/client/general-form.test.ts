import { describe, expect, test } from "bun:test";
import {
  buildAgentsPatch,
  buildWebAccessPatch,
  compressionThresholdError,
  deriveAgentsUnit,
  deriveWebAccessUnit,
  idleLeadError,
  idleMinTokensError
} from "@/routes/settings/general-form";
import type { SettingsConfigResponse } from "@/routes/settings/types";

/** Only the fields the derive functions read; cast keeps the fixture small. */
const config = {
  ok: true,
  server: { host: "127.0.0.1", port: 4173 },
  agent: { preferences: "Prefer Claude for planning.", compressionThresholdTokens: 128000, logRequests: "full" }
} as SettingsConfigResponse;

describe("general-form derive", () => {
  test("deriveAgentsUnit reads agent settings and stringifies the saved threshold", () => {
    expect(deriveAgentsUnit(config)).toEqual({
      preferences: "Prefer Claude for planning.",
      compressionThresholdTokens: "128000",
      logRequests: "full",
      // Idle compaction's defaults where the config has none.
      idleCompactionEnabled: true,
      idleCompactionLeadMinutes: "5",
      idleCompactionMinTokens: "200,000"
    });
  });

  test("deriveWebAccessUnit stringifies the port", () => {
    expect(deriveWebAccessUnit(config)).toEqual({ host: "127.0.0.1", port: "4173" });
  });
});

describe("general-form patches", () => {
  test("buildAgentsPatch sends a numeric threshold with the other agent settings", () => {
    expect(buildAgentsPatch({
      preferences: "Codex implements.",
      compressionThresholdTokens: " 0128000 ",
      logRequests: "metadata",
      idleCompactionEnabled: false,
      idleCompactionLeadMinutes: " 10 ",
      idleCompactionMinTokens: "150,000"
    })).toEqual({
      agent: {
        preferences: "Codex implements.", compressionThresholdTokens: 128000, logRequests: "metadata",
        idleCompactionEnabled: false, idleCompactionLeadMinutes: 10, idleCompactionMinTokens: 150000
      }
    });
  });

  test.each(["", " ", ",", "999", "-1000", "1000.5", "1,000.5", "1000.0", "2e5", "9007199254740992"])(
    "rejects an invalid threshold before sending settings: %j",
    (compressionThresholdTokens) => {
      const error = "Enter a whole number of at least 1,000 tokens.";
      expect(compressionThresholdError(compressionThresholdTokens)).toBe(error);
      expect(() => buildAgentsPatch({
        ...deriveAgentsUnit(config),
        compressionThresholdTokens
      })).toThrow(error);
    }
  );

  // The field shows a count with thousands separators, so it takes one back
  // with them, typed or pasted.
  test("a count written with thousands separators is accepted and sent as a number", () => {
    expect(compressionThresholdError("200,000")).toBe("");
    expect(buildAgentsPatch({
      ...deriveAgentsUnit(config),
      compressionThresholdTokens: " 200,000 "
    }).agent).toMatchObject({ compressionThresholdTokens: 200000 });
  });

  test("accepts the minimum threshold", () => {
    expect(compressionThresholdError("1000")).toBe("");
    expect(buildAgentsPatch({
      ...deriveAgentsUnit(config),
      compressionThresholdTokens: "1000"
    }).agent?.compressionThresholdTokens).toBe(1000);
  });

  test("buildWebAccessPatch shapes { server: { host, port } } with trim + numeric port", () => {
    expect(buildWebAccessPatch({ host: " 0.0.0.0 ", port: " 8080 " })).toEqual({
      server: { host: "0.0.0.0", port: 8080 }
    });
  });

  test("buildWebAccessPatch maps an empty port to 0 (automatic selection)", () => {
    expect(buildWebAccessPatch({ host: "127.0.0.1", port: "" })).toEqual({
      server: { host: "127.0.0.1", port: 0 }
    });
  });

  test("buildWebAccessPatch rejects a blank host", () => {
    expect(() => buildWebAccessPatch({ host: " ", port: "1" })).toThrow(
      "Listen address is required."
    );
  });

  test("buildWebAccessPatch rejects out-of-range and non-integer ports", () => {
    expect(() => buildWebAccessPatch({ host: "127.0.0.1", port: "70000" })).toThrow(
      "Port must be an integer between 0 and 65535."
    );
    expect(() => buildWebAccessPatch({ host: "127.0.0.1", port: "80.5" })).toThrow(
      "Port must be an integer between 0 and 65535."
    );
  });
});

describe("idle compaction fields", () => {
  test.each(["", "0", "60", "x", "7.5", "-1"])("refuses minutes before expiry %j", (lead) => {
    expect(idleLeadError(lead)).toBe("Enter whole minutes from 1 to 59.");
    expect(() => buildAgentsPatch({ ...deriveAgentsUnit(config), idleCompactionLeadMinutes: lead })).toThrow("Enter whole minutes from 1 to 59.");
  });
  test("takes 1 and 59", () => {
    expect([idleLeadError("1"), idleLeadError(" 59 ")]).toEqual(["", ""]);
  });
  test.each(["999", "x", "1000.5"])("refuses a smallest context of %j with the threshold's words", (min) => {
    expect(idleMinTokensError(min)).toBe("Enter a whole number of at least 1,000 tokens.");
    expect(() => buildAgentsPatch({ ...deriveAgentsUnit(config), idleCompactionMinTokens: min })).toThrow("Enter a whole number of at least 1,000 tokens.");
  });
  test("takes 1,000 written with separators", () => {
    expect(idleMinTokensError("1,000")).toBe("");
  });
  // Switched off, the two fields are hidden; what is in them then is neither
  // checked nor sent (the saved values stay).
  test("switched off, a value it would refuse is left out of the save", () => {
    const off = { ...deriveAgentsUnit(config), idleCompactionEnabled: false, idleCompactionLeadMinutes: "0", idleCompactionMinTokens: "x" };
    const agent = buildAgentsPatch(off).agent!;
    expect(agent.idleCompactionEnabled).toBe(false);
    expect([Object.hasOwn(agent, "idleCompactionLeadMinutes"), Object.hasOwn(agent, "idleCompactionMinTokens")]).toEqual([false, false]);
    expect(buildAgentsPatch({ ...off, idleCompactionLeadMinutes: "10", idleCompactionMinTokens: "150,000" }).agent).toMatchObject({ idleCompactionLeadMinutes: 10, idleCompactionMinTokens: 150000 });
  });
});
