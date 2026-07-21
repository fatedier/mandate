import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";

// Re-exported so the settings modules keep their single API import.
export { readJson };

type CodexLoginStartResponse = {
  ok: true;
  status: "pending";
  opened: boolean;
  requestId: string;
  url: string;
};

type CodexLoginStatusResponse =
  | { ok: true; status: "pending"; providerName: string; startedAt: string }
  | { ok: true; status: "authenticated"; providerName: string; email: string; accountId: string }
  | { ok: true; status: "failed"; providerName: string; error: string };

export async function loginCodex(providerName: string, onBrowserOpened: () => void): Promise<void> {
  const res = await fetch(api.codexAuthStart, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerName })
  });
  const login = await readJson<CodexLoginStartResponse>(res);
  if (!login.opened && typeof window !== "undefined") {
    window.open(login.url, "_blank", "noopener,noreferrer");
  }
  onBrowserOpened();

  const status = await pollCodexLogin(login.requestId);
  if (status.status === "failed") {
    throw new Error(status.error || "Codex sign-in failed.");
  }
}

async function pollCodexLogin(requestId: string): Promise<CodexLoginStatusResponse> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await delay(1500);
    const res = await fetch(api.codexAuthStatus(requestId));
    const status = await readJson<CodexLoginStatusResponse>(res);
    if (status.status !== "pending") return status;
  }
  return { ok: true, status: "failed", providerName: "", error: "Codex sign-in timed out." };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
