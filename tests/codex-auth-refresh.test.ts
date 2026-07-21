import { expect, test } from "bun:test";
import {
  deleteCodexAuthProfile, getCodexAuthProfile, resolveCodexAccess, saveCodexTokens
} from "../src/server/modules/codex/codex-auth-store.js";
import { codexAuthStore } from "./helpers/codex.js";

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
