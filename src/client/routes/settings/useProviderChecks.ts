import { useCallback, useRef, useState } from "react";
import { api } from "@/lib/api-paths";
import { errorText } from "@shared/error-text";
import type { ProviderCheckResponseEnvelope, ProviderCheckResult } from "@shared/api-contracts";
import { readJson } from "./settings-api";

export type ProviderCheckState =
  | { phase: "checking"; connection: string }
  | { phase: "done"; check: ProviderCheckResult; connection: string };

/** A provider's check, when it is for the saved connection the page shows
 *  (`connectionOf` its baseline); none when the settings changed since. */
export function checkFor(
  checks: Record<string, ProviderCheckState>,
  providerName: string,
  connection: string
): ProviderCheckState | undefined {
  const state = checks[providerName];
  return state && state.connection === connection ? state : undefined;
}

/**
 * Each saved provider's check, keyed by its name and tagged with the saved
 * connection it was asked for. A check lists the provider's models with its
 * saved settings (no prompt is sent); `maxAgeMs` lets the server answer from
 * one it ran that recently. One request per provider at a time: a fresh one
 * (0) asked for while one is on its way — a save landed — or one for other
 * settings drops that answer, which may be for the old settings, and checks
 * again once it is back. A check the list asks for again keeps the answer
 * it has for the same settings until the new one is back: a row that says
 * Ready does not flash Checking… on each visit.
 */
export function useProviderChecks() {
  const [checks, setChecks] = useState<Record<string, ProviderCheckState>>({});
  const inFlight = useRef(new Map<string, { again: boolean; connection: string }>());

  const runCheck = useCallback((providerName: string, maxAgeMs: number, connection = "") => {
    if (!providerName) return;
    const running = inFlight.current.get(providerName);
    if (running) {
      if (maxAgeMs === 0 || running.connection !== connection) {
        running.again = true;
        running.connection = connection;
        setChecks((prev) => ({ ...prev, [providerName]: { phase: "checking", connection } }));
      }
      return;
    }
    const start = (maxAge: number, target: string) => {
      const entry = { again: false, connection: target };
      inFlight.current.set(providerName, entry);
      setChecks((prev) => {
        const known = prev[providerName];
        if (maxAge > 0 && known?.phase === "done" && known.connection === target) return prev;
        return { ...prev, [providerName]: { phase: "checking", connection: target } };
      });
      void managerRequestCheck(providerName, maxAge).then((check) => {
        if (entry.again) {
          start(0, entry.connection);
          return;
        }
        inFlight.current.delete(providerName);
        setChecks((prev) => ({ ...prev, [providerName]: { phase: "done", check, connection: target } }));
      });
    };
    start(maxAgeMs, connection);
  }, []);

  return { checks, runCheck };
}

async function managerRequestCheck(providerName: string, maxAgeMs: number): Promise<ProviderCheckResult> {
  try {
    const res = await fetch(api.settingsProviderCheck(providerName), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxAgeMs })
    });
    return checkFrom(await readJson<Extract<ProviderCheckResponseEnvelope, { ok: true }>>(res));
  } catch (err) {
    // Mandate's own server could not answer: say why rather than spin.
    return { result: "failed", message: errorText(err), checkedAt: new Date().toISOString() };
  }
}

/** The check itself, without the envelope's fields. */
function checkFrom(payload: Extract<ProviderCheckResponseEnvelope, { ok: true }>): ProviderCheckResult {
  switch (payload.result) {
    case "ready":
      return { result: "ready", modelCount: payload.modelCount, checkedAt: payload.checkedAt };
    case "failed":
      return {
        result: "failed",
        message: payload.message,
        ...(payload.httpStatus !== undefined ? { httpStatus: payload.httpStatus } : {}),
        checkedAt: payload.checkedAt
      };
    case "unchecked":
      return { result: "unchecked", reason: payload.reason };
    default:
      // Not a check this page knows: say so rather than break the page.
      return { result: "failed", message: "The check's answer could not be read.", checkedAt: new Date().toISOString() };
  }
}
