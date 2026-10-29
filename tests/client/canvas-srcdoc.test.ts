import { expect, test } from "bun:test";
import { artboardAssetsUrl, buildCanvasSrcDoc, canvasAssetsUrl, canvasCsp } from "@/routes/canvas/canvas-srcdoc";

const ASSETS = "http://127.0.0.1:4100/api/canvas/cnv_1/assets/";

test("the CSP and base use the absolute assets URL, even from another origin", () => {
  // The desktop app's page origin is tauri://; its API is http://127.0.0.1:<port>.
  const csp = canvasCsp(ASSETS);
  expect(csp.split("; ")).toEqual([
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com ${ASSETS}`,
    `style-src 'unsafe-inline' https://fonts.googleapis.com ${ASSETS}`,
    "font-src https://fonts.gstatic.com data:",
    `img-src data: blob: ${ASSETS}`,
    `media-src data: blob: ${ASSETS}`,
    "worker-src blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    `base-uri ${ASSETS}`
  ]);
  const doc = buildCanvasSrcDoc("<title>x</title>", { canvasId: "cnv_1", theme: "light", assetsBaseUrl: ASSETS });
  expect(doc).toContain(`<base href="${ASSETS}" target="_blank">`);
  expect(canvasAssetsUrl("cnv_1")).toBe("http://localhost/api/canvas/cnv_1/assets/");
  // The desktop app's page is tauri://; its API, and so the report's
  // folder, is on the sidecar's http origin.
  window.__MANDATE_DESKTOP__ = { apiBaseUrl: "http://127.0.0.1:4100" };
  try {
    expect(canvasAssetsUrl("cnv_1")).toBe("http://127.0.0.1:4100/api/canvas/cnv_1/assets/");
  } finally {
    delete window.__MANDATE_DESKTOP__;
  }
});

test("page content is wrapped in the skeleton with the theme stamped", () => {
  const doc = buildCanvasSrcDoc("<title>Pool</title><main>Hi</main>", { canvasId: "cnv_1", theme: "dark", assetsBaseUrl: ASSETS });
  expect(doc.startsWith('<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta http-equiv="Content-Security-Policy"')).toBe(true);
  expect(doc).toContain(":root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}");
  expect(doc).toContain("body{margin:0;font:14px/1.5");
  expect(doc).toContain("img{max-width:100%}[hidden]{display:none!important}");
  // Its scrollbars are the viewer's: thin, a grey that reads on a light or a
  // dark page, over the page's own ground once the bridge has read it. As
  // faint as the app's own (a grey at 14% lifts white or a dark ground by
  // about as much as the app's thumb does). In a cascade layer that comes
  // before anything of the page's, so whatever the page says of its own
  // scrollbars wins.
  expect(doc).toContain("@layer{:root{scrollbar-color:rgb(128 128 128/.14) var(--mandate-ground,transparent)}*{scrollbar-width:thin}}");
  expect(doc.indexOf("@layer{")).toBeLessThan(doc.indexOf("<body>"));
  const body = doc.slice(doc.indexOf("<body>"));
  expect(body.startsWith("<body><title>Pool</title><main>Hi</main>")).toBe(true);
  expect(body.indexOf("data-mandate-bridge")).toBeGreaterThan(body.indexOf("</main>"));
  expect(body.endsWith("</body></html>")).toBe(true);
  // The CSP names cdn.tailwindcss.com (allowed); nothing loads Tailwind by itself.
  expect(doc).not.toMatch(/<script[^>]*tailwind/i);
});

test("a complete document is wrapped like page content: the skeleton, its CSP and runtime come first", () => {
  // The browser folds the author's shell into the skeleton (tested in e2e):
  // the doctype and <head> tag are dropped, <html>/<body> attributes are
  // added where the skeleton has none, and everything else stays in place.
  const malformed = [
    '<!DOCTYPE html><html lang="zh" data-theme="light"><head><script src="https://cdn.tailwindcss.com"></script></head><body class="x">Hi</body></html>',
    '<!-- generated --><script src="https://evil.example.com/x.js"></script><html><head></head><body>y</body></html>',
    "<!doctype html>visible<html><head></head><body>y</body></html>"
  ];
  for (const html of malformed) {
    const doc = buildCanvasSrcDoc(html, { canvasId: "cnv_1", theme: "dark", assetsBaseUrl: ASSETS });
    expect(doc.startsWith('<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport"')).toBe(true);
    const body = doc.indexOf("<body>");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(body);
    expect(doc.indexOf("data-mandate-runtime")).toBeLessThan(body);
    expect(doc.slice(body).startsWith(`<body>${html}<script data-mandate-bridge>`)).toBe(true);
  }
});

test("an artboard's page gets no theme stamp and carries the board list to the bridge", () => {
  const doc = buildCanvasSrcDoc("<p>x</p>", { canvasId: "cnv_1", theme: null, assetsBaseUrl: ASSETS, artboard: { path: "Main.html", boards: ["Main.html", "Pay.html"] } });
  expect(doc.startsWith('<!doctype html><html><head>')).toBe(true);
  expect(doc).not.toContain("data-theme=");
  expect(doc).toContain('"boards":["Main.html","Pay.html"]');
});

test("an artboard in a subfolder gets its own folder as its base", () => {
  expect(artboardAssetsUrl("cnv_1", "Main.html")).toBe("http://localhost/api/canvas/cnv_1/assets/");
  expect(artboardAssetsUrl("cnv_1", "screens/v2/Cart.html")).toBe("http://localhost/api/canvas/cnv_1/assets/screens/v2/");
});

test("an artboard in a subfolder may load files from anywhere in the canvas folder", () => {
  // Its base is its own folder, but "../logo.png" beside canvas.json must load.
  const doc = buildCanvasSrcDoc("<p>x</p>", {
    canvasId: "cnv_1",
    theme: null,
    assetsBaseUrl: `${ASSETS}screens/`,
    folderUrl: ASSETS,
    artboard: { path: "screens/Cart.html", boards: ["screens/Cart.html"] }
  });
  expect(doc).toContain(`<base href="${ASSETS}screens/" target="_blank">`);
  expect(doc).toContain(`img-src data: blob: ${ASSETS};`);
  expect(doc).toContain(`base-uri ${ASSETS}"`);
});

test("a head script of the viewer's sits after the runtime, before the page and </head>; the CSP is unchanged", () => {
  const plain = buildCanvasSrcDoc("<script>page()</script>", { canvasId: "agent-page", theme: "light", assetsBaseUrl: ASSETS });
  const doc = buildCanvasSrcDoc("<script>page()</script>", { canvasId: "agent-page", theme: "light", assetsBaseUrl: ASSETS, headScript: "<script data-mandate-page>window.mandate = {};</script>" });
  const at = doc.indexOf("data-mandate-page");
  expect(at).toBeGreaterThan(doc.indexOf("data-mandate-runtime"));
  expect(at).toBeLessThan(doc.indexOf("</head>"));
  expect(at).toBeLessThan(doc.indexOf("page()"));
  const csp = (d: string) => d.match(/Content-Security-Policy" content="([^"]*)"/)![1];
  expect(csp(doc)).toBe(csp(plain));
  expect(doc.replace("<script data-mandate-page>window.mandate = {};</script>", "")).toBe(plain);
});
