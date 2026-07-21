import { expect, test } from "bun:test";
import { buildCanvasSrcDoc } from "../src/client/routes/canvas/canvas-bridge.js";
import { canvasTailwindUrl } from "../src/client/routes/canvas/canvas-tailwind.js";

test("buildCanvasSrcDoc marks the theme and disables inline scrolling", () => {
  const html = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"></head>",
    "<body class=\"bg-slate-950 text-slate-100\"><div>Report</div></body></html>"
  ].join("");

  const srcDoc = buildCanvasSrcDoc(html, "cnv_test", {
    theme: "dark",
    autoSize: true
  });

  expect(srcDoc).toContain('data-mandate-theme="dark"');
  expect(srcDoc).toContain("overflow:hidden !important");
  expect(srcDoc).toContain(".min-h-screen");
  expect(srcDoc).toContain("min-height:auto !important");
  expect(srcDoc).toContain(".h-screen");
  expect(srcDoc).toContain("height:auto !important");
});

test("buildCanvasSrcDoc renders the agent's colors faithfully (no theme remapper)", () => {
  const srcDoc = buildCanvasSrcDoc(
    "<!doctype html><html><head></head><body class=\"bg-slate-50\"><div class=\"bg-emerald-50 border border-emerald-200 text-emerald-800\">OK</div></body></html>",
    "cnv_test",
    { theme: "dark" }
  );

  // The old palette/token system and color remapper are gone — canvases own
  // their own palette, so we must NOT rewrite the agent's colors.
  expect(srcDoc).not.toContain("color-mix(in srgb");
  expect(srcDoc).not.toContain("background-color: var(--card)");
  expect(srcDoc).not.toContain("window.tailwind.config");
  expect(srcDoc).not.toContain("var(--border-soft)");
});

test("buildCanvasSrcDoc does not override agent-authored CSS tokens", () => {
  const srcDoc = buildCanvasSrcDoc(
    [
      "<!doctype html>",
      "<html><head><style>",
      ":root { --muted: #8a9a98; --background: #090c0d; --foreground: #eef4f3; --primary: #3ec8d1; }",
      "body { background: var(--background); color: var(--foreground); }",
      "p { color: var(--muted); }",
      "a { color: var(--primary); }",
      "</style></head><body><p>Readable copy</p></body></html>"
    ].join(""),
    "cnv_test",
    { theme: "dark" }
  );

  const baseStyle = extractBaseStyle(srcDoc);
  expect(baseStyle).toContain("--mandate-canvas-background");
  expect(baseStyle).toContain("--mandate-canvas-foreground");
  expect(baseStyle).toContain("--mandate-canvas-muted");
  expect(baseStyle).toContain("--mandate-canvas-primary");
  expect(baseStyle).not.toContain("--background:");
  expect(baseStyle).not.toContain("--foreground:");
  expect(baseStyle).not.toContain("--muted:");
  expect(baseStyle).not.toContain("--primary:");
  expect(baseStyle).not.toContain("var(--background)");
  expect(baseStyle).not.toContain("var(--foreground)");
  expect(baseStyle).not.toContain("var(--muted)");
  expect(baseStyle).not.toContain("var(--primary)");
  expect(baseStyle).toContain(":where(body)");
  expect(baseStyle).not.toContain("\nbody {");

  expect(srcDoc).toContain("--muted: #8a9a98");
  expect(srcDoc.indexOf("--muted: #8a9a98")).toBeLessThan(srcDoc.indexOf("id=\"mandate-canvas-base\""));
});

test("buildCanvasSrcDoc auto-size measurement ignores iframe viewport height", () => {
  const srcDoc = buildCanvasSrcDoc(
    "<body class=\"min-h-screen\"><main class=\"h-screen\">Report</main></body>",
    "cnv_test",
    { autoSize: true }
  );

  expect(srcDoc).not.toContain("root.scrollHeight");
  expect(srcDoc).toContain("root.offsetHeight");
  expect(srcDoc).toContain('style.position === "fixed"');
  expect(srcDoc).toContain("body.querySelectorAll(\"*\")");
});

test("buildCanvasSrcDoc keeps full-page canvases scrollable", () => {
  const srcDoc = buildCanvasSrcDoc("<div>Report</div>", "cnv_test", {
    theme: "light",
    autoSize: false
  });

  expect(srcDoc).toContain('data-mandate-theme="light"');
  expect(srcDoc).toContain("overflow:auto");
});

test("buildCanvasSrcDoc marks body-only documents with the active theme", () => {
  const srcDoc = buildCanvasSrcDoc(
    "<body class=\"bg-slate-900 text-slate-100\"><main>Report</main></body>",
    "cnv_test",
    { theme: "dark" }
  );

  expect(srcDoc).toContain('<body class="bg-slate-900 text-slate-100" data-mandate-theme="dark">');
});

test("buildCanvasSrcDoc installs sandbox runtime before user head scripts", () => {
  const srcDoc = buildCanvasSrcDoc(
    "<!doctype html><html><head><script data-user-script>localStorage.getItem('x')</script></head><body>Report</body></html>",
    "cnv_test"
  );

  const sandboxIndex = srcDoc.indexOf("data-mandate-sandbox-runtime");
  const userScriptIndex = srcDoc.indexOf("data-user-script");
  expect(sandboxIndex).toBeGreaterThanOrEqual(0);
  expect(userScriptIndex).toBeGreaterThanOrEqual(0);
  expect(sandboxIndex).toBeLessThan(userScriptIndex);
  expect(srcDoc).toContain("installStorageFallback(\"localStorage\")");
  expect(srcDoc).toContain("installStorageFallback(\"sessionStorage\")");
});

test("buildCanvasSrcDoc injects canvas asset base before user head resources", () => {
  const srcDoc = buildCanvasSrcDoc(
    "<!doctype html><html><head><link rel=\"stylesheet\" href=\"styles/app.css\"></head><body><img src=\"preview/page.png\"></body></html>",
    "cnv_test",
    { assetBaseUrl: "/api/canvas/cnv_test/assets" }
  );

  const baseIndex = srcDoc.indexOf("data-mandate-canvas-assets");
  const linkIndex = srcDoc.indexOf("styles/app.css");
  expect(baseIndex).toBeGreaterThanOrEqual(0);
  expect(baseIndex).toBeLessThan(linkIndex);
  expect(srcDoc).toContain('<base data-mandate-canvas-assets href="/api/canvas/cnv_test/assets/">');
});

test("buildCanvasSrcDoc injects base style into the real head when scripts contain html markers", () => {
  const srcDoc = buildCanvasSrcDoc(
    "<!doctype html><html><head><script>const marker = '</head><body>';</script></head><body>Report</body></html>",
    "cnv_test"
  );

  const styleIndex = srcDoc.indexOf("id=\"mandate-canvas-base\"");
  const bodyIndex = srcDoc.lastIndexOf("<body>");
  expect(styleIndex).toBeGreaterThanOrEqual(0);
  expect(bodyIndex).toBeGreaterThanOrEqual(0);
  expect(styleIndex).toBeLessThan(bodyIndex);
  expect(srcDoc).toContain("const marker = '</head><body>';");
});

test("buildCanvasSrcDoc injects the local Tailwind asset without a custom color config", () => {
  const srcDoc = buildCanvasSrcDoc(
    "<!doctype html><html><head></head><body>Report</body></html>",
    "cnv_test"
  );

  expect(srcDoc).toContain(`src="${canvasTailwindUrl()}"`);
  expect(srcDoc).not.toContain("cdn.tailwindcss.com");
  expect(srcDoc).not.toContain("window.tailwind.config");
});

test("buildCanvasSrcDoc localizes the author's Tailwind script without double injection", () => {
  const srcDoc = buildCanvasSrcDoc(
    "<!doctype html><html><head><script src=\"https://cdn.tailwindcss.com\"></script></head><body>Report</body></html>",
    "cnv_test"
  );

  const first = srcDoc.indexOf(canvasTailwindUrl()!);
  const last = srcDoc.lastIndexOf(canvasTailwindUrl()!);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(first).toBe(last);
  expect(srcDoc).not.toContain("cdn.tailwindcss.com");
});

test("buildCanvasSrcDoc preserves nonce and config script order", () => {
  const config = "tailwind.config = { theme: { extend: { colors: { accent: '#123456' } } } };";
  const html = `<html><head><SCRIPT nonce="fixture" crossorigin="anonymous" integrity="old-cdn-hash" SRC='//cdn.tailwindcss.com/3.4.17'></SCRIPT><script>${config}</script></head><body>Report</body></html>`;
  const srcDoc = buildCanvasSrcDoc(html, "cnv_test");
  const url = canvasTailwindUrl()!;
  expect(srcDoc).toContain(`src="${url}"`);
  expect(srcDoc).toContain('nonce="fixture"');
  expect(srcDoc).not.toContain("crossorigin");
  expect(srcDoc).not.toContain("old-cdn-hash");
  expect(srcDoc.indexOf(url)).toBeLessThan(srcDoc.indexOf(config));
});

test("buildCanvasSrcDoc only rewrites actual script sources", () => {
  const literal = 'const example = \'<script src="https://cdn.tailwindcss.com">\';';
  const comment = '<!-- <script src="https://cdn.tailwindcss.com"></script> -->';
  const other = '<script data-note="https://cdn.tailwindcss.com" src="/custom.js"></script>';
  const srcDoc = buildCanvasSrcDoc(`<html><head>${comment}<script>${literal}</script>${other}</head><body>Report</body></html>`, "cnv_test");
  expect(srcDoc).toContain(literal);
  expect(srcDoc).toContain(comment);
  expect(srcDoc).toContain(other);
  expect(srcDoc).toContain(`src="${canvasTailwindUrl()}"`);
});

test("buildCanvasSrcDoc handles unquoted script URLs and keeps standalone opt-outs", () => {
  const srcDoc = buildCanvasSrcDoc('<html><head><script src=https://cdn.tailwindcss.com></script></head><body>Report</body></html>', "cnv_test");
  expect(srcDoc).toContain(`src="${canvasTailwindUrl()}"`);
  const standalone = buildCanvasSrcDoc('<!-- @tailwind: standalone styles --><p>Report</p>', "cnv_test");
  expect(standalone).not.toContain(canvasTailwindUrl()!);
});

test("buildCanvasSrcDoc does not replace unsupported runtimes or lookalike hosts", () => {
  const unsupported = '<script src="https://cdn.tailwindcss.com/4"></script>';
  const srcDoc = buildCanvasSrcDoc(`<html><head>${unsupported}</head><body>Report</body></html>`, "cnv_test");
  expect(srcDoc).toContain(unsupported);
  expect(srcDoc).not.toContain(canvasTailwindUrl()!);
  expect(canvasTailwindUrl("https://cdn.tailwindcss.com.example.com")).toBeNull();
});

test("buildCanvasSrcDoc keeps module-marked Tailwind deferred as a classic runtime", () => {
  const srcDoc = buildCanvasSrcDoc('<html><head><script type="module" nomodule src="https://cdn.tailwindcss.com"></script></head><body>Report</body></html>', "cnv_test");
  expect(srcDoc).toContain(`src="${canvasTailwindUrl()}" defer=""`);
  expect(srcDoc).not.toContain('type="module"');
  expect(srcDoc).not.toContain("nomodule");
});

test("buildCanvasSrcDoc localizes protocol-relative CDN tags under the desktop scheme", () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, "location");
  Object.defineProperty(window, "location", { value: { href: "tauri://localhost/index.html" }, configurable: true });
  try {
    const srcDoc = buildCanvasSrcDoc('<html><head><script src="//cdn.tailwindcss.com/3.4.17"></script></head><body>Report</body></html>', "cnv_test", {
      assetBaseUrl: "http://localhost:9999/api/canvases/cnv_test/assets/"
    });
    expect(srcDoc).toContain(`src="${canvasTailwindUrl()}"`);
    expect(srcDoc).not.toContain("cdn.tailwindcss.com");
  } finally {
    if (descriptor) Object.defineProperty(window, "location", descriptor);
    else Reflect.deleteProperty(window, "location");
  }
});

test("buildCanvasSrcDoc uses the same full runtime for explicit plugin requests", () => {
  const script = '<script src="https://cdn.tailwindcss.com/3.4.17?plugins=typography@0.5.16&#44;forms&amp;other=1" crossorigin="anonymous"></script>';
  const srcDoc = buildCanvasSrcDoc(`<html><head>${script}</head><body>Report</body></html>`, "cnv_test");
  expect(srcDoc).toContain(`src="${canvasTailwindUrl()}"`);
  expect(srcDoc).not.toContain("cdn.tailwindcss.com");
  expect(srcDoc).not.toContain("?plugins=");
});

function extractBaseStyle(srcDoc: string): string {
  const start = srcDoc.indexOf("<style id=\"mandate-canvas-base\">");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = srcDoc.indexOf("</style>", start);
  expect(end).toBeGreaterThan(start);
  return srcDoc.slice(start, end);
}
