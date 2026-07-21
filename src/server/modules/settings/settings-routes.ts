import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  API_ROUTES,
  type ProviderModelsResponseEnvelope,
  type SettingsConfigResponseEnvelope,
  type StorageCleanupResponse,
  type StorageStatusResponse
} from "../../../shared/api-contracts.js";
import { SettingsService } from "./settings-service.js";
import { truncateChatToolResults } from "../../platform/db/retention.js";
import type { Config } from "../../config.js";
import type { HttpClient } from "../../platform/http/http-client.js";
import type { MandateStore } from "../../app/store.js";

/** Rows the manual cleanup materializes per chunk. Larger than the hourly pass's
 *  200 because nothing here has to yield to the event loop between chunks -- this
 *  is a foreground operation the user is waiting on -- and small enough that peak
 *  memory is a few hundred rows of content rather than the whole candidate set. */
const CLEANUP_CHUNK_ROWS = 500;

export interface SettingsRoutesDeps {
  reloadConfig?: () => Config;
  httpClient?: HttpClient;
  store?: MandateStore;
  config?: Config;
}

/** The on-disk database file size (page_count * page_size), deliberately not
 *  sum(length(content)) over agent_messages: that sum is a logical count of
 *  column bytes that a vacuum cannot move, so reporting it would report a
 *  number that stays put whether a vacuum ran, failed, or was skipped --
 *  while the file size is both what the user's disk actually shows and the
 *  only one of the two a vacuum affects. Also ~400x cheaper to compute (1ms
 *  vs. 403ms on the 527.7 MB production database), since it reads two
 *  pragmas instead of scanning every row. Exported so the storage-cleanup
 *  test can pin this property against the real function rather than a
 *  hand-rolled duplicate query. */
export function measureDatabaseBytes(db: Database): number {
  const pageCount = (db.prepare("pragma page_count").get() as { page_count: number }).page_count;
  const pageSize = (db.prepare("pragma page_size").get() as { page_size: number }).page_size;
  return pageCount * pageSize;
}

export function mountSettingsRoutes(app: Hono, deps: SettingsRoutesDeps = {}) {
  const settings = new SettingsService({
    reloadConfig: deps.reloadConfig,
    httpClient: deps.httpClient
  });

  app.get(API_ROUTES.settingsConfig, (c) => {
    return c.json({
      ok: true,
      ...settings.getConfigPayload(false)
    } satisfies SettingsConfigResponseEnvelope);
  });

  app.post(API_ROUTES.settingsConfig, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON" }, 400);
    }

    try {
      return c.json({ ok: true, ...settings.updateConfig(body) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: message }, 400);
    }
  });

  app.post(API_ROUTES.codexAuthStart, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON" }, 400);
    }
    try {
      return c.json({ ok: true, ...(await settings.startCodexLogin(body)) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: message }, 400);
    }
  });

  app.get(API_ROUTES.codexAuthStatus, (c) => {
    const requestId = c.req.query("requestId") ?? "";
    if (!requestId) return c.json({ ok: false, error: "requestId is required" }, 400);
    const status = settings.getCodexLoginStatus(requestId);
    if (!status) return c.json({ ok: false, error: "login request not found" }, 404);
    return c.json({ ok: true, ...status });
  });

  app.post(API_ROUTES.codexAuthLogout, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON" }, 400);
    }
    try {
      return c.json({ ok: true, ...settings.logoutCodex(body) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: message }, 400);
    }
  });

  app.get(API_ROUTES.settingsProviderModels, async (c) => {
    const providerName = c.req.param("providerName") ?? "";
    const refresh = c.req.query("refresh") === "1";
    try {
      return c.json({
        ok: true,
        ...(await settings.listProviderModels(providerName, { refresh }))
      } satisfies ProviderModelsResponseEnvelope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: message }, 400);
    }
  });

  app.get(API_ROUTES.storageStatus, (c) => {
    const db = deps.store?.db;
    if (!db) return c.json({ ok: false, error: "database unavailable" }, 503);
    return c.json({ ok: true, databaseBytes: measureDatabaseBytes(db) } satisfies StorageStatusResponse);
  });

  app.post(API_ROUTES.storageCleanup, (c) => {
    // Not authentication -- this server has none, and every mutating endpoint
    // beside this one is equally open. What this closes is that the endpoint
    // took no body and required no header, which made it a CORS *simple
    // request*: any page in the user's browser could POST to it while Mandate
    // was running and irreversibly rewrite chat history, with no preflight to
    // stop it and no response it needed to read. Requiring a content-type the
    // simple-request rules do not allow forces a preflight, which a cross-origin
    // page cannot pass. Cheap, and it does not pretend to be an auth boundary.
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return c.json({ ok: false, error: "content-type: application/json is required" }, 415);
    }

    const db = deps.store?.db;
    const retention = deps.config?.retention;
    if (!db || !retention) return c.json({ ok: false, error: "database unavailable" }, 503);

    const bytesBefore = measureDatabaseBytes(db);
    const cutoff = new Date(Date.now() - retention.chatRetentionDays * 24 * 60 * 60 * 1000);
    // Unthrottled on purpose: the hourly pass has a per-tick cap so it cannot
    // block the loop, but the manual action is a foreground operation the user
    // asked for and is told to wait on. overCeiling is also forced true here,
    // not a shortcut: the user pressing this button *is* the reason to ignore
    // the age gate, so every eligible row is truncated regardless of age.
    //
    // Unthrottled is not unbounded, though. One call with maxRows =
    // MAX_SAFE_INTEGER materializes `id + content` for every candidate at once --
    // 11,428 rows today, and the number only grows -- so it runs in chunks
    // instead, which costs one extra query per chunk and holds a bounded amount
    // of the table in memory. Terminating on a zero tick is only sound because
    // the query's predicate now selects exactly the rows
    // truncateToolResultContent() will rewrite: a tick that changes nothing has
    // nothing left to change.
    const cutoffIso = cutoff.toISOString();
    let truncated = 0;
    for (;;) {
      const n = truncateChatToolResults(db, {
        headChars: retention.chatToolResultHeadChars,
        cutoffIso,
        maxRows: CLEANUP_CHUNK_ROWS,
        overCeiling: true
      });
      if (n === 0) break;
      truncated += n;
    }
    // Without this the file does not shrink -- freed pages are reused by later
    // writes rather than returned to the filesystem, which is exactly the
    // distinction measureDatabaseBytes above exists to report -- and
    // bytesBefore/bytesAfter would come back identical. Measured at 14 s on a
    // 527 MB database.
    db.exec("vacuum");
    return c.json({
      ok: true, truncated, bytesBefore, bytesAfter: measureDatabaseBytes(db)
    } satisfies StorageCleanupResponse);
  });
}
