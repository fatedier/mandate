import type { Hono } from "hono";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import { AGENT_PAGE_BUILTINS, AGENT_PAGE_LIMITS, type AgentPageBuiltin } from "../../../shared/api/agent-page.js";
import type { PageStore } from "./page-store.js";
import type { PageSourceManager } from "./page-sources.js";
import type { PageUpdateManager } from "./page-updates.js";
import { readBuiltin, type PageBuiltinDeps } from "./page-builtins.js";
import type { PageAnswers } from "./page-answers.js";
import { siteFileDigest } from "./page-site.js";

export interface PageRouteDeps {
  pageStore: PageStore;
  sources?: Pick<PageSourceManager, "list" | "data" | "setPaused" | "remove">;
  updates?: Pick<PageUpdateManager, "list" | "setPaused" | "remove">;
  builtins?: PageBuiltinDeps;
  answers?: Pick<PageAnswers, "add" | "unread">;
}

const isBuiltin = (name: string): name is AgentPageBuiltin => (AGENT_PAGE_BUILTINS as readonly string[]).includes(name);

export function mountPageRoutes(app: Hono, deps: PageRouteDeps): void {
  app.get(API_ROUTES.agentPage, (c) => c.json(deps.pageStore.state()));
  app.get(API_ROUTES.agentPageVersion, (c) => {
    const revision = Number(c.req.param("revision"));
    const version = Number.isSafeInteger(revision) ? deps.pageStore.version(revision) : null;
    return version ? c.json(version) : c.json({ error: "page version not found" }, 404);
  });
  // A file of a version, by its path in the page's folder: what its pages
  // load (stylesheets, scripts, images), or a file a link opens.
  app.get(API_ROUTES.agentPageFile, (c) => {
    const revision = Number(c.req.param("revision"));
    const bytes = Number.isSafeInteger(revision) ? deps.pageStore.file(revision, c.req.param("filePath")) : null;
    if (!bytes) return c.json({ error: "page file not found" }, 404);
    // A link opens a file in a tab of its own, outside the frame's sandbox.
    // Served from Mandate's origin, an HTML file there could then drive
    // Mandate's API (it has no auth), so every file is sandboxed: an opaque
    // origin, no scripts, no forms. What the page itself loads ignores it.
    c.header("Content-Security-Policy", "sandbox");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "private, no-cache");
    const etag = `"${siteFileDigest(bytes)}"`;
    c.header("ETag", etag);
    if (c.req.header("If-None-Match")?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) return c.body(null, 304);
    c.header("Content-Type", Bun.file(c.req.param("filePath")).type);
    return c.body(new Uint8Array(bytes));
  });
  // A built-in is read as it is asked for; a listed source as its last run left it.
  app.get(API_ROUTES.agentPageData, async (c) => {
    const name = c.req.param("name");
    if (isBuiltin(name) && deps.builtins) {
      return c.json({ name, value: await readBuiltin(name, deps.builtins), at: new Date().toISOString(), error: null });
    }
    const data = deps.sources?.data(name) ?? null;
    return data ? c.json(data) : c.json({ error: "page source not found" }, 404);
  });
  // What the user gave on the page: a JSON value of at most answerMaxBytes.
  app.post(API_ROUTES.agentPageAnswers, async (c) => {
    if (!deps.answers) return c.json({ error: "page answers are not available" }, 404);
    const text = await c.req.text();
    // The value's limit and room for the {"value": …} around it.
    if (Buffer.byteLength(text, "utf8") > AGENT_PAGE_LIMITS.answerMaxBytes + 64) return c.json({ error: "an answer is at most 8 KB of JSON" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "the answer is not JSON" }, 400);
    }
    if (!body || typeof body !== "object" || !("value" in body) || (body as { value: unknown }).value === undefined) {
      return c.json({ error: "send {\"value\": …}" }, 400);
    }
    const value = (body as { value: unknown }).value;
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > AGENT_PAGE_LIMITS.answerMaxBytes) return c.json({ error: "an answer is at most 8 KB of JSON" }, 413);
    if (deps.answers.unread() >= AGENT_PAGE_LIMITS.answersUnreadMax) {
      return c.json({ error: `${AGENT_PAGE_LIMITS.answersUnreadMax} answers are waiting for the personal agent already` }, 429);
    }
    return c.json({ answer: deps.answers.add(value) });
  });
  app.get(API_ROUTES.agentPageSources, (c) => c.json({ sources: deps.sources?.list() ?? [] }));
  app.patch(API_ROUTES.agentPageSource, async (c) => {
    const body = await c.req.json().catch(() => null) as { paused?: unknown } | null;
    if (typeof body?.paused !== "boolean") return c.json({ error: "paused must be true or false" }, 400);
    const source = deps.sources?.setPaused(c.req.param("name"), body.paused) ?? null;
    return source ? c.json({ source }) : c.json({ error: "page source not found" }, 404);
  });
  app.delete(API_ROUTES.agentPageSource, (c) => {
    const removed = deps.sources?.remove(c.req.param("name")) ?? false;
    return removed ? c.json({ removed: true }) : c.json({ error: "page source not found" }, 404);
  });
  app.get(API_ROUTES.agentPageUpdates, (c) => c.json({ updates: deps.updates?.list() ?? [] }));
  app.patch(API_ROUTES.agentPageUpdate, async (c) => {
    const body = await c.req.json().catch(() => null) as { paused?: unknown } | null;
    if (typeof body?.paused !== "boolean") return c.json({ error: "paused must be true or false" }, 400);
    const update = deps.updates?.setPaused(c.req.param("name"), body.paused) ?? null;
    return update ? c.json({ update }) : c.json({ error: "page update not found" }, 404);
  });
  app.delete(API_ROUTES.agentPageUpdate, (c) => {
    const removed = deps.updates?.remove(c.req.param("name")) ?? false;
    return removed ? c.json({ removed: true }) : c.json({ error: "page update not found" }, 404);
  });
}
