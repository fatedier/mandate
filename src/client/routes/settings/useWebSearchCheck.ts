import { useCallback, useState } from "react";
import { api } from "@/lib/api-paths";
import { errorText } from "@shared/error-text";
import type { WebSearchCheckResponseEnvelope, WebSearchCheckResult } from "@shared/api/settings";
import { readJson } from "./settings-api";
import type { SettingsConfigResponse } from "./types";

type CheckState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; result: WebSearchCheckResult; config: SettingsConfigResponse };

/** The Web search check, run only when asked: each one spends a search. Its
 *  answer holds for the settings it ran with; a save drops it. */
export function useWebSearchCheck(config: SettingsConfigResponse | null) {
  const [state, setState] = useState<CheckState>({ phase: "idle" });
  const run = useCallback(() => {
    if (!config) return;
    setState({ phase: "checking" });
    void managerRequestCheck().then((result) => setState({ phase: "done", result, config }));
  }, [config]);
  const result = state.phase === "done" && state.config === config ? state.result : null;
  return { checking: state.phase === "checking", result, run };
}

async function managerRequestCheck(): Promise<WebSearchCheckResult> {
  try {
    const res = await fetch(api.settingsWebSearchCheck, { method: "POST" });
    const body = await readJson<Extract<WebSearchCheckResponseEnvelope, { ok: true }>>(res);
    return body.result === "works"
      ? { result: "works", count: body.count, ms: body.ms, ...(body.answer ? { answer: body.answer } : {}), top: body.top ?? [] }
      : { result: "failed", message: body.message, ...(body.reply ? { reply: body.reply } : {}) };
  } catch (err) {
    // Mandate's own server could not answer: say why rather than spin.
    return { result: "failed", message: errorText(err) };
  }
}
