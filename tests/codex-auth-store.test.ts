import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  type AuthStoreFile,
  codexProfileId,
  deleteCodexAuthProfile,
  getCodexAuthProfile,
  getCodexAuthStatus,
  onCodexCredentialsChanged,
  resolveCodexAccess,
  saveCodexTokens
} from "../src/server/modules/codex/codex-auth-store.js";
import type { HttpClient } from "../src/server/platform/http/http-client.js";
import { codexAuthStore } from "./helpers/codex.js";
import { MemoryJsonStore } from "./helpers/memory-json-store.js";
import { tempDir } from "./helpers/temp.js";

test("Codex auth store saves OAuth profiles with private file permissions", async () => {
  const dir = tempDir("md-codex-auth-");
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
});

test("Codex auth store matches provider names exactly", async () => {
  const dir = tempDir("md-codex-auth-");
  saveCodexTokens("Codex", {
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

test("signing in and signing out are announced; a refresh of a signed-in profile is not", () => {
  const store = new MemoryJsonStore<AuthStoreFile>({});
  const heard: string[] = [];
  const stop = onCodexCredentialsChanged((providerName) => heard.push(providerName));
  try {
    const tokens = { access_token: "a", refresh_token: "r", expires_in: 3600 };
    saveCodexTokens("codex", tokens, store);
    saveCodexTokens("codex", { ...tokens, access_token: "b" }, store); // a refresh
    deleteCodexAuthProfile("codex", store);
    deleteCodexAuthProfile("codex", store); // nothing was left
  } finally { stop(); }
  expect(heard).toStrictEqual(["codex", "codex"]);
  saveCodexTokens("codex", { access_token: "c", refresh_token: "r", expires_in: 3600 }, store);
  expect(heard).toHaveLength(2);
});

function expiredStore() {
  const store = codexAuthStore();
  const data = store.read();
  data.profiles!["codex:default"]!.expiresAt = 0;
  store.write(data);
  return store;
}

for (const refresh_token of [undefined, ""]) {
  test(`Codex refresh retains the existing refresh token when replacement is ${String(refresh_token)}`, async () => {
    const store = expiredStore();
    const profile = await resolveCodexAccess("codex", store, {
      httpClient: { async fetch() { return Response.json({ access_token: "new-access", refresh_token }); } }
    });
    expect(profile.refresh).toBe("test-refresh");
    expect(profile.access).toBe("new-access");
    expect(getCodexAuthProfile("codex", store)?.refresh).toBe("test-refresh");
  });
}

test("Codex concurrent refreshes share one request and persist one token rotation", async () => {
  const store = expiredStore();
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let requests = 0;
  const deps = { httpClient: { async fetch() {
    requests++;
    started.resolve();
    await released.promise;
    return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 });
  } } };
  const first = resolveCodexAccess("codex", store, deps);
  await started.promise;
  const others = Array.from({ length: 8 }, () => resolveCodexAccess("codex", store, deps));
  released.resolve();
  const profiles = await Promise.all([first, ...others]);
  expect(requests).toBe(1);
  expect(profiles.every(profile => profile.access === "rotated-access" && profile.refresh === "rotated-refresh")).toBe(true);
  // A delayed 401 from the previous generation must reuse this rotation.
  expect((await resolveCodexAccess("codex", store, { ...deps, rejectedAccessToken: "test-access" })).access)
    .toBe("rotated-access");
  expect(requests).toBe(1);
});

test("Codex refresh failure releases the shared owner so a later attempt can recover", async () => {
  const store = expiredStore();
  const released = Promise.withResolvers<void>();
  let requests = 0;
  const deps = { httpClient: { async fetch() {
    requests++;
    if (requests === 1) {
      await released.promise;
      return new Response("failed", { status: 503 });
    }
    return Response.json({ access_token: "recovered" });
  } } };
  const pending = [resolveCodexAccess("codex", store, deps), resolveCodexAccess("codex", store, deps)];
  released.resolve();
  const results = await Promise.allSettled(pending);
  expect(results.every(result => result.status === "rejected")).toBe(true);
  expect(requests).toBe(1);
  expect(getCodexAuthProfile("codex", store)?.access).toBe("test-access");
  expect((await resolveCodexAccess("codex", store, deps)).access).toBe("recovered");
  expect(requests).toBe(2);
});

test("Codex refresh rejects malformed credentials without overwriting the store", async () => {
  const store = expiredStore();
  const original = store.snapshot();
  await expect(resolveCodexAccess("codex", store, {
    httpClient: { async fetch() { return Response.json({ refresh_token: "new-refresh" }); } }
  })).rejects.toThrow(/invalid credentials/);
  expect(store.snapshot()).toEqual(original);
});

for (const action of ["logout", "login"] as const) {
  test(`Codex late refresh cannot overwrite a concurrent ${action}`, async () => {
    const store = expiredStore();
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const pending = resolveCodexAccess("codex", store, {
      httpClient: { async fetch() {
        started.resolve();
        await released.promise;
        return Response.json({ access_token: "late-access", refresh_token: "late-refresh" });
      } }
    });
    await started.promise;
    if (action === "logout") deleteCodexAuthProfile("codex", store);
    else saveCodexTokens("codex", { access_token: "login-access", refresh_token: "login-refresh" }, store);
    released.resolve();
    if (action === "logout") {
      await expect(pending).rejects.toThrow(/credentials changed/);
      expect(getCodexAuthProfile("codex", store)).toBeNull();
    } else {
      expect((await pending).access).toBe("login-access");
      expect(getCodexAuthProfile("codex", store)?.refresh).toBe("login-refresh");
    }
  });
}

for (const includeOriginalIdToken of [false, true]) {
  test(`Codex token refresh cannot switch accounts (original ID token: ${includeOriginalIdToken})`, async () => {
    const store = expiredStore();
    const data = store.read();
    data.profiles!["codex:default"]!.accountId = "original-account";
    store.write(data);
    const claims = Buffer.from(JSON.stringify({ chatgpt_account_id: "different-account" })).toString("base64url");
    const originalClaims = Buffer.from(JSON.stringify({ chatgpt_account_id: "original-account" })).toString("base64url");
    await expect(resolveCodexAccess("codex", store, {
      httpClient: { async fetch() { return Response.json({
        access_token: `e30.${claims}.test`,
        ...(includeOriginalIdToken ? { id_token: `e30.${originalClaims}.test` } : {})
      }); } }
    })).rejects.toThrow(/account changed/);
    expect(getCodexAuthProfile("codex", store)?.accountId).toBe("original-account");
  });
}
