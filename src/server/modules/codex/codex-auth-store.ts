import path from "node:path";
import { withCodexUserAgent } from "./codex-http.js";
import { resolveDataDir } from "../../platform/fs/data-dir.js";
import {
  isJsonRecord,
  JsonFileStore,
  type JsonStore
} from "../../platform/storage/json-store.js";
import {
  globalHttpClient,
  type HttpClient
} from "../../platform/http/http-client.js";

const CODEX_PROVIDER_TYPE = "codex";
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export interface CodexOAuthTokens {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

export interface CodexAuthProfile {
  providerName: string;
  providerType: "codex";
  type: "oauth";
  access: string;
  refresh: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
  updatedAt: string;
}

export interface AuthStoreFile {
  profiles?: Record<string, CodexAuthProfile>;
  providerDefaults?: Record<string, string>;
}

export type CodexAuthStorage = JsonStore<AuthStoreFile>;
export type CodexAuthStoreSource = string | CodexAuthStorage;

export interface CodexAuthDeps {
  httpClient?: HttpClient;
  /** Refresh a rejected credential even if its local expiry is still valid. */
  rejectedAccessToken?: string;
}

// All model instances in the server share the same refresh owner. Storage
// objects are keyed by identity; file stores by their absolute directory.
const pendingRefreshes = new Map<CodexAuthStoreSource, Map<string, Promise<CodexAuthProfile>>>();

export function codexProfileId(providerName: string) {
  return `${providerName}:default`;
}

export function getCodexAuthProfile(
  providerName: string,
  source: CodexAuthStoreSource = resolveDataDir()
): CodexAuthProfile | null {
  const store = readAuthStore(source);
  return store.profiles?.[codexProfileId(providerName)] ?? null;
}

export function getCodexAuthStatus(providerName: string, source: CodexAuthStoreSource = resolveDataDir()) {
  const profileId = codexProfileId(providerName);
  const profile = readAuthStore(source).profiles?.[profileId];
  if (!profile) {
    return {
      status: "missing" as const,
      configured: false,
      accountId: "",
      email: "",
      profileId: codexProfileId(providerName)
    };
  }
  return {
    status: profile.expiresAt <= Date.now() ? ("expired" as const) : ("authenticated" as const),
    configured: true,
    accountId: profile.accountId ?? "",
    email: profile.email ?? "",
    profileId
  };
}

export function saveCodexTokens(
  providerName: string,
  tokens: CodexOAuthTokens,
  source: CodexAuthStoreSource = resolveDataDir()
) {
  const now = Date.now();
  const identity = extractCodexIdentity(tokens);
  const profileId = codexProfileId(providerName);
  const store = readAuthStore(source);
  const existing = store.profiles?.[profileId];
  const profile: CodexAuthProfile = {
    providerName,
    providerType: CODEX_PROVIDER_TYPE,
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expiresAt: now + normalizeTokenLifetimeMs(tokens.expires_in),
    accountId: identity.accountId ?? existing?.accountId,
    email: identity.email ?? existing?.email,
    updatedAt: new Date(now).toISOString()
  };
  store.profiles = { ...(store.profiles ?? {}), [profileId]: profile };
  store.providerDefaults = { ...(store.providerDefaults ?? {}), [providerName]: profileId };
  writeAuthStore(store, source);
  return profile;
}

export function deleteCodexAuthProfile(providerName: string, source: CodexAuthStoreSource = resolveDataDir()) {
  const profileId = codexProfileId(providerName);
  const store = readAuthStore(source);
  if (store.profiles) {
    delete store.profiles[profileId];
  }
  if (store.providerDefaults) {
    for (const [provider, defaultProfileId] of Object.entries(store.providerDefaults)) {
      if (provider === providerName || defaultProfileId === profileId) {
        delete store.providerDefaults[provider];
      }
    }
  }
  writeAuthStore(store, source);
}

export function renameCodexAuthProfile(
  fromProviderName: string,
  toProviderName: string,
  source: CodexAuthStoreSource = resolveDataDir()
) {
  const from = fromProviderName.trim();
  const to = toProviderName.trim();
  if (!from || !to || from === to) return;

  const fromProfileId = codexProfileId(from);
  const toProfileId = codexProfileId(to);
  const store = readAuthStore(source);
  const sourceProfile = store.profiles?.[fromProfileId];
  if (!sourceProfile) return;

  store.profiles = { ...(store.profiles ?? {}) };
  if (!store.profiles[toProfileId]) {
    store.profiles[toProfileId] = {
      ...sourceProfile,
      providerName: to,
      updatedAt: new Date().toISOString()
    };
  }
  delete store.profiles[fromProfileId];

  store.providerDefaults = { ...(store.providerDefaults ?? {}) };
  for (const [provider, profileId] of Object.entries(store.providerDefaults)) {
    if (provider === from || profileId === fromProfileId) {
      delete store.providerDefaults[provider];
    }
  }
  store.providerDefaults[to] = toProfileId;
  writeAuthStore(store, source);
}

export async function resolveCodexAccess(
  providerName: string,
  source: CodexAuthStoreSource = resolveDataDir(),
  deps: CodexAuthDeps = {}
) {
  const profile = getCodexAuthProfile(providerName, source);
  if (!profile) {
    throw new Error(`OpenAI Codex OAuth is not authenticated for provider "${providerName}".`);
  }
  if (profile.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS
    && profile.access !== deps.rejectedAccessToken) {
    return profile;
  }
  const key = typeof source === "string" ? path.resolve(source) : source;
  const pending = pendingRefreshes.get(key)?.get(providerName);
  if (pending) return pending;

  const refresh = (async () => {
    const tokens = await refreshCodexTokens(profile.refresh, deps.httpClient ?? globalHttpClient);
    const current = getCodexAuthProfile(providerName, source);
    // A late refresh must not resurrect a logout or overwrite a new login.
    if (!current || current.access !== profile.access || current.refresh !== profile.refresh
      || current.updatedAt !== profile.updatedAt || current.accountId !== profile.accountId) {
      if (current && current.accountId === profile.accountId
        && current.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) return current;
      throw new Error("OpenAI Codex credentials changed during token refresh. Retry the request.");
    }
    const identity = extractCodexIdentity(tokens);
    const accessAccountId = accountIdFromClaims(parseJwtClaims(tokens.access_token));
    if ((profile.accountId && identity.accountId && profile.accountId !== identity.accountId)
      || (identity.accountId && accessAccountId && identity.accountId !== accessAccountId)) {
      throw new Error("OpenAI Codex account changed during token refresh. Sign in again.");
    }
    return saveCodexTokens(providerName, tokens, source);
  })();
  const byProvider = pendingRefreshes.get(key) ?? new Map<string, Promise<CodexAuthProfile>>();
  byProvider.set(providerName, refresh);
  pendingRefreshes.set(key, byProvider);
  try {
    return await refresh;
  } finally {
    byProvider.delete(providerName);
    if (byProvider.size === 0) pendingRefreshes.delete(key);
  }
}

async function refreshCodexTokens(refreshToken: string, httpClient: HttpClient): Promise<CodexOAuthTokens> {
  const response = await httpClient.fetch(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    // A canceled inference must not cancel a refresh shared by other callers.
    signal: AbortSignal.timeout(30_000),
    headers: withCodexUserAgent({ "Content-Type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID
    })
  });
  if (!response.ok) {
    throw new Error(`OpenAI Codex token refresh failed: HTTP ${response.status}`);
  }
  const tokens: unknown = await response.json();
  if (!isRecord(tokens) || typeof tokens.access_token !== "string" || !tokens.access_token.trim()
    || (tokens.refresh_token != null && typeof tokens.refresh_token !== "string")
    || (tokens.id_token != null && typeof tokens.id_token !== "string")) {
    throw new Error("OpenAI Codex token refresh returned invalid credentials.");
  }
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || refreshToken,
    ...(typeof tokens.id_token === "string" ? { id_token: tokens.id_token } : {}),
    ...(typeof tokens.expires_in === "number" ? { expires_in: tokens.expires_in } : {})
  };
}

function authStorePath(dir = resolveDataDir()) {
  return path.join(dir, "auth.json");
}

function createCodexAuthStorage(dir = resolveDataDir()): CodexAuthStorage {
  return new JsonFileStore<AuthStoreFile>({
    filePath: authStorePath(dir),
    defaultValue: () => ({}),
    validate: isAuthStoreFile,
    invalidMessage: "auth.json must contain an object",
    mode: 0o600
  });
}

function readAuthStore(source: CodexAuthStoreSource): AuthStoreFile {
  return resolveCodexAuthStorage(source).read();
}

function writeAuthStore(store: AuthStoreFile, source: CodexAuthStoreSource) {
  resolveCodexAuthStorage(source).write(store);
}

function resolveCodexAuthStorage(source: CodexAuthStoreSource): CodexAuthStorage {
  return typeof source === "string" ? createCodexAuthStorage(source) : source;
}

function isAuthStoreFile(value: unknown): value is AuthStoreFile {
  return isJsonRecord(value);
}

function normalizeTokenLifetimeMs(expiresIn: unknown) {
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return Math.trunc(expiresIn * 1000);
  }
  return 60 * 60 * 1000;
}

function extractCodexIdentity(tokens: CodexOAuthTokens): { accountId?: string; email?: string } {
  const idClaims = tokens.id_token ? parseJwtClaims(tokens.id_token) : null;
  const accessClaims = parseJwtClaims(tokens.access_token);
  return {
    accountId: accountIdFromClaims(idClaims) ?? accountIdFromClaims(accessClaims),
    email: stringFromClaims(idClaims?.email) ?? stringFromClaims(accessClaims?.email)
  };
}

function accountIdFromClaims(claims: Record<string, unknown> | null): string | undefined {
  if (!claims) return undefined;
  const auth = isRecord(claims["https://api.openai.com/auth"])
    ? claims["https://api.openai.com/auth"]
    : null;
  const organizations = Array.isArray(claims.organizations) ? claims.organizations : [];
  const firstOrganization = isRecord(organizations[0]) ? organizations[0] : null;
  return stringFromClaims(claims.chatgpt_account_id)
    ?? stringFromClaims(auth?.chatgpt_account_id)
    ?? stringFromClaims(firstOrganization?.id);
}

function stringFromClaims(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
