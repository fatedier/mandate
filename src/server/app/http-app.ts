import { Hono, type Context } from "hono";
import { createBunWebSocket, serveStatic } from "hono/bun";
import { compress } from "hono/compress";
import type { ServerWebSocket } from "bun";
import path from "node:path";
import fs from "node:fs";
import { mountApiRoutes } from "./api-routes.js";
import type { AppDeps } from "./deps.js";
import { toUserFacingError } from "../platform/errors.js";
import { logError } from "../platform/logger.js";
import { CommandDidNotAnswerError } from "../platform/process/command-runner.js";
import { API_ROUTES } from "../../shared/api-contracts.js";

interface BuildAppResult {
  app: Hono;
  // The Bun.serve `websocket` handler created by createBunWebSocket. server.ts
  // passes this verbatim to Bun.serve so upgrades flow through Hono's
  // upgradeWebSocket middleware.
  websocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>["websocket"];
}

// Static-serve root expressed relative to the project root (cwd) — that's what
// hono/bun's serveStatic expects, and it also works in `bun build --compile`
// binaries where __dirname points into the embedded snapshot.
const CLIENT_DIST_ROOT_REL = "./dist/client";
const CLIENT_DIST_DIR = path.resolve(process.cwd(), "dist", "client");

// Vite emits content-hashed filenames under /assets/ (js, css, fonts), so
// those responses never change for a given URL and can be cached forever.
// Everything else — index.html and the unhashed /brand/ files — must
// revalidate so deploys take effect on the next load.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE = "no-cache";

export function staticCacheControl(pathname: string): string {
  return pathname.startsWith("/assets/") ? IMMUTABLE_CACHE : REVALIDATE_CACHE;
}

// Lazily resolve the virtual `mandate-web-ui.gen.ts` module. It's only present
// in binaries produced by scripts/build-binary.ts, which uses Bun.build's
// `files` option to inject a generated path map. During source execution
// the import fails and we fall back to disk-based serveStatic.
let embeddedUIPromise: Promise<Record<string, string> | null> | null = null;
function loadEmbeddedUI(): Promise<Record<string, string> | null> {
  if (embeddedUIPromise) return embeddedUIPromise;
  embeddedUIPromise = (async () => {
    try {
      // @ts-expect-error - virtual module produced at compile time
      const mod = await import("mandate-web-ui.gen.ts");
      return (mod.default ?? mod) as Record<string, string>;
    } catch {
      return null;
    }
  })();
  return embeddedUIPromise;
}

/** Every route's last word on a thrown error. A command that did not answer
 *  in time is a 503 the user can retry, not a 500. */
export function onHttpError(err: Error, c: Context): Response {
  logError(`http ${c.req.method} ${requestPath(c.req.url)}`, err, "request failed");
  if (err instanceof CommandDidNotAnswerError) {
    return c.json({ error: err.message, retryable: true }, 503);
  }
  const userError = toUserFacingError(err, "Request failed.");
  return c.json({
    error: userError.message,
    category: userError.category,
    retryable: userError.retryable
  }, 500);
}

export function buildApp(deps: AppDeps): BuildAppResult {
  const app = new Hono();
  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
  const compressJson = compress({ contentTypeFilter: /^application\/json(?:;|$)/i });

  app.onError(onHttpError);

  // Outside CORS so its Vary: Origin is retained alongside Accept-Encoding.
  // Never wrap an SSE stream or a WebSocket upgrade in a compression stream.
  app.use("/api/*", (c, next) => {
    if (c.req.path === API_ROUTES.events || c.req.header("upgrade")?.toLowerCase() === "websocket") {
      return next();
    }
    return compressJson(c, next);
  });

  const checkOrigin = deps.config.checkOrigin !== false;

  app.use("/api/*", async (c, next) => {
    const origin = allowedCorsOrigin(c.req.header("origin"));
    if (checkOrigin && !origin && sentByAnotherSite(c)) {
      return c.json({ error: "Refused: this request was sent by a page of another site." }, 403);
    }
    if (c.req.method === "OPTIONS") {
      if (origin) {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      return new Response(null, { status: 204 });
    }

    await next();
    if (origin) {
      for (const [key, value] of corsHeaders(origin)) {
        c.header(key, value, { append: key.toLowerCase() === "vary" });
      }
    }
  });

  mountApiRoutes(app, upgradeWebSocket, deps);

  // Compress static assets. Deliberately mounted here — after the API routes —
  // rather than globally: /api/events is SSE and /api/terminal is a WebSocket
  // upgrade, and running either through a compression stream buffers or breaks
  // it. Only the static handlers below are wrapped.
  //
  // The client ships ~600KB of JavaScript on first paint. Over a LAN that is
  // invisible; over a slow link, serving it
  // uncompressed costs roughly 3x the transfer.
  app.use("/*", compress());

  // Static file serving — must come AFTER all /api/* routes.
  // Compiled binaries use the embedded path map (mandate-web-ui.gen.ts).
  // Otherwise fall back to disk-based serveStatic on ./dist/client (cwd-relative).
  app.get("/*", async (c, next) => {
    const embedded = await loadEmbeddedUI();
    if (!embedded) return next();
    const reqPath = new URL(c.req.url).pathname;
    const key = reqPath === "/" ? "index.html" : reqPath.replace(/^\//, "");
    const filepath = embedded[key] ?? embedded["index.html"];
    if (!filepath) return c.notFound();
    // SPA fallbacks serve index.html regardless of the requested path — the
    // cache policy must follow what is SERVED, not what was asked for.
    const servedPath = embedded[key] ? reqPath : "/index.html";
    return new Response(Bun.file(filepath), {
      headers: { "Cache-Control": staticCacheControl(servedPath) }
    });
  });
  app.get(
    "/*",
    serveStatic({
      root: CLIENT_DIST_ROOT_REL,
      rewriteRequestPath: (p) => (p === "/" ? "/index.html" : p),
      onFound: (_localPath, c) => {
        c.header("Cache-Control", staticCacheControl(requestPath(c.req.url)));
      }
    })
  );

  // SPA fallback: if neither the embedded map nor serveStatic matched a real
  // file, serve index.html so React Router can handle the route.
  app.get("*", (c) => {
    const indexPath = path.join(CLIENT_DIST_DIR, "index.html");
    try {
      const html = fs.readFileSync(indexPath, "utf8");
      return c.html(html, 200, { "Cache-Control": REVALIDATE_CACHE });
    } catch {
      return c.text(
        "Client build not found. Run `bun run build` before starting the server, or use `bun run dev` for development.",
        503
      );
    }
  });

  return { app, websocket };
}

function allowedCorsOrigin(origin: string | undefined): string {
  if (!origin) return "";
  try {
    const url = new URL(origin);
    if (["http:", "https:"].includes(url.protocol)) {
      if (
        url.hostname === "tauri.localhost" ||
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1"
      ) {
        return origin;
      }
    }
    if (["tauri:", "asset:"].includes(url.protocol) && url.hostname === "localhost") {
      return origin;
    }
  } catch {
    return "";
  }
  return "";
}

/**
 * True for a write or a WebSocket handshake that a page of another site sent.
 *
 * Mandate has no login, so what stands between a web page open in the user's
 * browser and this server is the browser's own rules, and those let any page
 * SEND a form-like write or open a WebSocket to an address it can reach; they
 * only keep it from reading the answer. The browser does say who is sending:
 * it puts the page's origin on every cross-site write and on every handshake,
 * and a page cannot change it. So a request with an Origin is accepted when
 * that origin is the address the request was sent to, its Host header, and
 * refused otherwise. Local origins and the desktop app are let through before
 * this is asked.
 *
 * Only Host is read. What a request says a proxy was asked for
 * (X-Forwarded-Host and the like) is written by the sender, so a proxy in
 * front has to pass Host on as it received it; one that cannot is what the
 * `checkOrigin` switch is for.
 *
 * A request with no Origin is not from another site's page (curl, a script, a
 * same-origin read). Reads are left alone: no GET changes anything, and the
 * browser already withholds the answer from a page of another site.
 */
function sentByAnotherSite(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return false;
  const handshake = c.req.header("upgrade")?.toLowerCase() === "websocket";
  if (!handshake && ["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return false;
  const asked = c.req.header("host") || new URL(c.req.url).host;
  try {
    const from = new URL(origin);
    // Read under the origin's scheme: a proxy in front may end TLS, which this
    // server cannot know, and a scheme's default port may be written out on
    // one side and left off on the other.
    return new URL(`${from.protocol}//${asked}`).host !== from.host;
  } catch {
    // "null": a sandboxed frame or a local file, which is nobody's own page.
    return true;
  }
}

function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function corsHeaders(origin: string) {
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  });
}
