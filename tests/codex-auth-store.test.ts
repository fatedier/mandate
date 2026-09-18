import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AuthStoreFile,
  codexProfileId,
  deleteCodexAuthProfile,
  getCodexAuthProfile,
  getCodexAuthStatus,
  renameCodexAuthProfile,
  resolveCodexAccess,
  saveCodexTokens
} from "../src/server/modules/codex/codex-auth-store.js";
import type { HttpClient } from "../src/server/platform/http/http-client.js";
import { MemoryJsonStore } from "./helpers/memory-json-store.js";

test("Codex auth store saves OAuth profiles with private file permissions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-codex-auth-"));
  try {
    const profile = saveCodexTokens("codex", {
      access_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }),
      refresh_token: "refresh-token",
      id_token: fakeJwt({ email: "dev@example.test" }),
      expires_in: 3600
    }, dir);

    expect(codexProfileId("codex")).toBe("codex:default");
    expect(profile).toMatchObject({
      providerName: "codex",
      providerType: "codex",
      type: "oauth",
      refresh: "refresh-token",
      accountId: "acct_test",
      email: "dev@example.test"
    });
    expect(typeof profile.access).toBe("string");
    expect(getCodexAuthStatus("codex", dir)).toMatchObject({
      status: "authenticated",
      configured: true,
      accountId: "acct_test",
      email: "dev@example.test",
      profileId: "codex:default"
    });
    expect(await resolveCodexAccess("codex", dir)).toMatchObject({ access: profile.access });

    const authPath = path.join(dir, "auth.json");
    expect(fs.existsSync(authPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);
    }

    deleteCodexAuthProfile("codex", dir);
    expect(getCodexAuthProfile("codex", dir)).toBeNull();
    expect(getCodexAuthStatus("codex", dir)).toMatchObject({ status: "missing", configured: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex auth store matches provider names exactly and supports explicit rename", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-codex-auth-"));
  try {
    const profile = saveCodexTokens("Codex", {
      access_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }),
      refresh_token: "refresh-token",
      id_token: fakeJwt({ email: "dev@example.test" }),
      expires_in: 3600
    }, dir);

    expect(getCodexAuthStatus("codex", dir)).toMatchObject({
      status: "missing",
      configured: false,
      profileId: "codex:default"
    });
    try {
      await resolveCodexAccess("codex", dir);
      throw new Error("expected resolveCodexAccess to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("not authenticated");
    }

    renameCodexAuthProfile("Codex", "codex", dir);
    expect(getCodexAuthProfile("Codex", dir)).toBeNull();
    expect(getCodexAuthStatus("codex", dir)).toMatchObject({
      status: "authenticated",
      configured: true,
      email: "dev@example.test",
      accountId: "acct_test",
      profileId: "codex:default"
    });
    expect(await resolveCodexAccess("codex", dir)).toMatchObject({
      providerName: "codex",
      access: profile.access
    });

    const authFile = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    expect(Object.keys(authFile.profiles)).toEqual(["codex:default"]);
    expect(authFile.providerDefaults).toEqual({ codex: "codex:default" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex auth store can run against an injected storage backend", () => {
  const store = new MemoryJsonStore<AuthStoreFile>({});

  saveCodexTokens("codex", {
    access_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_memory" } }),
    refresh_token: "refresh-token",
    id_token: fakeJwt({ email: "memory@example.test" }),
    expires_in: 3600
  }, store);

  expect(getCodexAuthStatus("codex", store)).toMatchObject({
    status: "authenticated",
    configured: true,
    accountId: "acct_memory",
    email: "memory@example.test"
  });
  expect(store.snapshot().profiles?.["codex:default"]?.providerName).toBe("codex");

  deleteCodexAuthProfile("codex", store);
  expect(getCodexAuthStatus("codex", store)).toMatchObject({ status: "missing", configured: false });
});

test("Codex auth store refreshes through an injected HTTP client", async () => {
  const store = new MemoryJsonStore<AuthStoreFile>({
    profiles: {
      "codex:default": {
        providerName: "codex",
        providerType: "codex",
        type: "oauth",
        access: "expired-access",
        refresh: "refresh-old",
        expiresAt: Date.now() - 1000,
        updatedAt: new Date().toISOString()
      }
    },
    providerDefaults: { codex: "codex:default" }
  });
  let captured = null as { url: string; init?: RequestInit } | null;
  const httpClient: HttpClient = {
    async fetch(input, init) {
      captured = { url: String(input), init };
      return new Response(JSON.stringify({
        access_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_refreshed" } }),
        refresh_token: "refresh-new",
        id_token: fakeJwt({ email: "refreshed@example.test" }),
        expires_in: 3600
      }), { status: 200 });
    }
  };

  const profile = await resolveCodexAccess("codex", store, { httpClient });

  expect(profile.access).not.toBe("expired-access");
  expect(profile.refresh).toBe("refresh-new");
  expect(profile.accountId).toBe("acct_refreshed");
  expect(profile.email).toBe("refreshed@example.test");
  expect(captured?.url).toBe("https://auth.openai.com/oauth/token");
  expect(String(captured?.init?.body)).toContain("grant_type=refresh_token");
  expect(String(captured?.init?.body)).toContain("refresh_token=refresh-old");
  expect(new Headers(captured?.init?.headers).get("User-Agent")).toBe("Mandate/0.1.0");
});

function fakeJwt(payload: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature"
  ].join(".");
}
