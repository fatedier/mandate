import crypto from "node:crypto";
import {
  saveCodexTokens,
  type CodexAuthStoreSource,
  type CodexOAuthTokens
} from "./codex-auth-store.js";
import { withCodexUserAgent } from "./codex-http.js";
import {
  globalHttpClient,
  type HttpClient
} from "../../platform/http/http-client.js";

const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

type OAuthStatus =
  | { status: "pending"; providerName: string; startedAt: string }
  | { status: "authenticated"; providerName: string; email: string; accountId: string }
  | { status: "failed"; providerName: string; error: string };

type PendingLogin = {
  providerName: string;
  verifier: string;
  state: string;
  startedAt: number;
  status: OAuthStatus;
  httpClient: HttpClient;
  authStore?: CodexAuthStoreSource;
};

const pendingByState = new Map<string, PendingLogin>();
const pendingByRequestId = new Map<string, PendingLogin>();
let callbackServer: ReturnType<typeof Bun.serve> | null = null;

export interface CodexBrowserLoginDeps {
  httpClient?: HttpClient;
  authStore?: CodexAuthStoreSource;
}

export async function startCodexBrowserLogin(
  providerName: string,
  deps: CodexBrowserLoginDeps = {}
) {
  ensureCallbackServer();
  pruneExpiredLogins();

  const verifier = randomBase64Url(32);
  const challenge = pkceChallenge(verifier);
  const requestId = randomBase64Url(18);
  const state = `${requestId}.${randomBase64Url(18)}`;
  const pending: PendingLogin = {
    providerName,
    verifier,
    state,
    startedAt: Date.now(),
    status: { status: "pending", providerName, startedAt: new Date().toISOString() },
    httpClient: deps.httpClient ?? globalHttpClient,
    authStore: deps.authStore
  };
  pendingByState.set(state, pending);
  pendingByRequestId.set(requestId, pending);

  return {
    requestId,
    url: buildAuthorizeUrl({ challenge, state })
  };
}

export function getCodexBrowserLoginStatus(requestId: string): OAuthStatus | null {
  pruneExpiredLogins();
  return pendingByRequestId.get(requestId)?.status ?? null;
}

function ensureCallbackServer() {
  if (callbackServer) return;
  try {
    callbackServer = Bun.serve({
      port: CALLBACK_PORT,
      fetch: handleCallbackRequest
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenAI Codex login callback port ${CALLBACK_PORT} is not available: ${message}`);
  }
}

async function handleCallbackRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== CALLBACK_PATH) {
    return new Response("Not found", { status: 404 });
  }

  const state = url.searchParams.get("state") ?? "";
  const pending = pendingByState.get(state);
  if (!pending) {
    return htmlResponse("Authorization Failed", "Invalid or expired login request.", 400);
  }

  const requestId = state.split(".")[0] ?? "";
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");
  if (error) {
    markFailed(pending, errorDescription || error);
    return htmlResponse("Authorization Failed", errorDescription || error, 400);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    markFailed(pending, "Missing authorization code.");
    return htmlResponse("Authorization Failed", "Missing authorization code.", 400);
  }

  try {
    const tokens = await exchangeCodeForTokens(code, pending.verifier, pending.httpClient);
    const profile = saveCodexTokens(pending.providerName, tokens, pending.authStore ?? undefined);
    pending.status = {
      status: "authenticated",
      providerName: pending.providerName,
      email: profile.email ?? "",
      accountId: profile.accountId ?? ""
    };
    pendingByState.delete(state);
    if (requestId) pendingByRequestId.set(requestId, pending);
    return htmlResponse("Authorization Complete", "You can close this window and return to Mandate.", 200);
  } catch (authError) {
    const message = authError instanceof Error ? authError.message : String(authError);
    markFailed(pending, message);
    return htmlResponse("Authorization Failed", message, 500);
  }
}

function buildAuthorizeUrl(params: { challenge: string; state: string }) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CODEX_CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    scope: "openid profile email offline_access",
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: params.state,
    originator: "mandate"
  });
  return `${OPENAI_AUTH_BASE_URL}/oauth/authorize?${query.toString()}`;
}

async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  httpClient: HttpClient
): Promise<CodexOAuthTokens> {
  const response = await httpClient.fetch(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: withCodexUserAgent({ "Content-Type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK_URL,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: verifier
    })
  });
  if (!response.ok) {
    throw new Error(`OpenAI Codex token exchange failed: HTTP ${response.status}`);
  }
  return await response.json() as CodexOAuthTokens;
}

function markFailed(pending: PendingLogin, error: string) {
  pending.status = { status: "failed", providerName: pending.providerName, error };
  pendingByState.delete(pending.state);
}

function pruneExpiredLogins() {
  const cutoff = Date.now() - LOGIN_TIMEOUT_MS;
  for (const [state, pending] of pendingByState) {
    if (pending.startedAt >= cutoff) continue;
    pending.status = { status: "failed", providerName: pending.providerName, error: "Login timed out." };
    pendingByState.delete(state);
  }
}

function pkceChallenge(verifier: string) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function randomBase64Url(bytes: number) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function htmlResponse(title: string, message: string, status: number) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return new Response(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${safeTitle}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #15171a; color: #f4f5f6; }
      main { width: min(520px, calc(100vw - 32px)); }
      h1 { font-size: 22px; margin: 0 0 10px; }
      p { color: #b8bec6; line-height: 1.5; margin: 0; }
    </style>
  </head>
  <body>
    <main>
      <h1>${safeTitle}</h1>
      <p>${safeMessage}</p>
    </main>
  </body>
</html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
