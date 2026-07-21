import { Hono } from "hono";
import { createBunWebSocket, serveStatic } from "hono/bun";
import { compress } from "hono/compress";
import type { ServerWebSocket } from "bun";
import path from "node:path";
import fs from "node:fs";
import { mountApiRoutes } from "./api-routes.js";
import type { AppDeps } from "./deps.js";
import { toUserFacingError } from "../platform/errors.js";
import { logError } from "../platform/logger.js";
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

export function buildApp(deps: AppDeps): BuildAppResult {
  const app = new Hono();
  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
  const compressJson = compress({ contentTypeFilter: /^application\/json(?:;|$)/i });

  app.onError((err, c) => {
    logError(`http ${c.req.method} ${requestPath(c.req.url)}`, err, "request failed");
    const userError = toUserFacingError(err, "Request failed.");
    return c.json({
      error: userError.message,
      category: userError.category,
      retryable: userError.retryable
    }, 500);
  });

  // Outside CORS so its Vary: Origin is retained alongside Accept-Encoding.
  // Never wrap an SSE stream or a WebSocket upgrade in a compression stream.
  app.use("/api/*", (c, next) => {
    if (c.req.path === API_ROUTES.events || c.req.header("upgrade")?.toLowerCase() === "websocket") {
      return next();
    }
    return compressJson(c, next);
  });

  app.use("/api/*", async (c, next) => {
    const origin = allowedCorsOrigin(c.req.header("origin"));
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
  // invisible, but this app is routinely reached through an frp tunnel, where
  // serving it uncompressed costs roughly 3x the transfer.
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
