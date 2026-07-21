import { describe, expect, test } from "bun:test";
import {
  buildAgentsPatch,
  buildWebAccessPatch,
  compressionThresholdError,
  deriveAgentsUnit,
  deriveWebAccessUnit
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
      logRequests: "full"
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
      logRequests: "metadata"
    })).toEqual({
      agent: { preferences: "Codex implements.", compressionThresholdTokens: 128000, logRequests: "metadata" }
    });
  });

  test.each(["", " ", "999", "-1000", "1000.5", "1000.0", "2e5", "200,000", "9007199254740992"])(
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
