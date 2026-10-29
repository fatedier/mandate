import { expect, test } from "bun:test";
import { hasOwnDocumentShell, readCanvasTitle, readDeclaredViewport } from "../src/server/modules/canvas/canvas-html.js";

test("readCanvasTitle decodes entities, collapses whitespace and caps at 120 characters", () => {
  expect(readCanvasTitle("<title>  JSON &amp; project-1\n  wire </title><p>x</p>")).toBe("JSON & project-1 wire");
  expect(readCanvasTitle("<TITLE data-x=1>Cache rules</TITLE>")).toBe("Cache rules");
  expect(readCanvasTitle("<title>A &#8212; &#x42;</title>")).toBe("A — B");
  expect(readCanvasTitle(`<title>${"a".repeat(200)}</title>`)).toBe("a".repeat(120));
  expect(readCanvasTitle("<title> </title>")).toBeNull();
  expect(readCanvasTitle("<h1>No title</h1>")).toBeNull();
});

test("readCanvasTitle scans only the first 8 KB, counted in bytes", () => {
  // 3,000 CJK characters are 9,000 bytes in UTF-8 but only 3,007 characters.
  const pad = `<p>${"字".repeat(3000)}</p>`;
  expect(readCanvasTitle(`${pad}<title>Late</title>`)).toBeNull();
  expect(readCanvasTitle(`<title>Early</title>${pad}`)).toBe("Early");
});

test("readDeclaredViewport: the first viewport meta that names a width decides", () => {
  expect(readDeclaredViewport('<meta name="viewport" content="width=1280"><meta name="viewport" content="width=1600">')).toEqual({ width: 1280 });
  // One that names no width (device-width) does not count as the first.
  expect(readDeclaredViewport('<meta name="viewport" content="width=device-width"><meta name="viewport" content="width=1440">')).toEqual({ width: 1440 });
});

test("readDeclaredViewport reads a desktop width, ignores device-width and flags out-of-range values", () => {
  expect(readDeclaredViewport('<meta name="viewport" content="width=1280">')).toEqual({ width: 1280 });
  expect(readDeclaredViewport("<meta content='width=1600, initial-scale=1' name=viewport>")).toEqual({ width: 1600 });
  expect(readDeclaredViewport('<meta name="viewport" content="width=device-width, initial-scale=1">')).toBeNull();
  expect(readDeclaredViewport('<meta name="viewport" content="width=320">')).toEqual({ invalid: "320" });
  expect(readDeclaredViewport('<meta name="viewport" content="width=3000">')).toEqual({ invalid: "3000" });
  expect(readDeclaredViewport('<meta name="viewport" content="width=wide">')).toEqual({ invalid: "wide" });
  expect(readDeclaredViewport('<meta name="description" content="width=1280">')).toBeNull();
  expect(readDeclaredViewport("<p>no meta</p>")).toBeNull();
  expect(readDeclaredViewport('<meta name="viewport" content="width=600">')).toEqual({ width: 600 });
  expect(readDeclaredViewport('<meta name="viewport" content="width=2561">')).toEqual({ invalid: "2561" });
});

test("hasOwnDocumentShell sees doctype, html, head and body tags but not lookalikes or comments", () => {
  for (const html of ["<!doctype html><p>x</p>", "<!DOCTYPE html>", '<html lang="zh">', "<head>", "<body class=x>"]) {
    expect(hasOwnDocumentShell(html)).toBe(true);
  }
  for (const html of ["<title>x</title><main>y</main>", "<!-- <html> -->", "<header>x</header>", "<bodyguard>", ""]) {
    expect(hasOwnDocumentShell(html)).toBe(false);
  }
});

test("readDeclaredViewport reads only live viewport metas and exact integer widths", () => {
  expect(readDeclaredViewport('<!-- <meta name="viewport" content="width=320"> --><meta name="viewport" content="width=1280">')).toEqual({ width: 1280 });
  expect(readDeclaredViewport('<meta data-name="viewport" content="width=320">')).toBeNull();
  expect(readDeclaredViewport('<script>"<meta name=viewport content=width=320>"</script>')).toBeNull();
  expect(readDeclaredViewport('<meta name="viewport" content="width=1e3">')).toEqual({ invalid: "1e3" });
  expect(readDeclaredViewport('<meta name="viewport" content="width=1000.0">')).toEqual({ invalid: "1000.0" });
  expect(readDeclaredViewport('<meta name="viewport" content="width=">')).toEqual({ invalid: "" });
});

test("titles decode entities case-sensitively and come only from live markup", () => {
  expect(readCanvasTitle("<title>Caf&eacute; &Eacute;t&eacute; &AMP; co</title>")).toBe("Café Été & co");
  // HTML's whole entity table, not a subset.
  expect(readCanvasTitle("<title>A &Rarr; B &rarr; C</title>")).toBe("A ↠ B → C");
  expect(readCanvasTitle("<script>const start = '<!--';</script><title>Report</title>")).toBe("Report");
  expect(readCanvasTitle("<template><template></template><title>Hidden</title></template><title>Real</title>")).toBe("Real");
  expect(readCanvasTitle("<title-card>Card</title-card><title>Real</title>")).toBe("Real");
  expect(readCanvasTitle('<iframe srcdoc="<title>Inner</title>"></iframe><title>Outer</title>')).toBe("Outer");
  expect(readCanvasTitle(`<title>${"x".repeat(9000)}</title>`)).toBeNull();
});

test("viewport metas are whole meta tags with whole attributes", () => {
  expect(readDeclaredViewport("<meta-panel name=viewport content=width=320>")).toBeNull();
  expect(readDeclaredViewport('<iframe srcdoc="<meta name=viewport content=width=1280>"></iframe>')).toBeNull();
  expect(readDeclaredViewport('<META NAME="Viewport" CONTENT="width=1280">')).toEqual({ width: 1280 });
});

test("a document shell inside an attribute or a template is not the page's shell", () => {
  expect(hasOwnDocumentShell('<iframe srcdoc="<html><body>Preview</body></html>"></iframe>')).toBe(false);
  expect(hasOwnDocumentShell("<template><body>x</body></template>")).toBe(false);
  expect(hasOwnDocumentShell("<p>a < b</p><main>x</main>")).toBe(false);
  // A shell after other content: the parser has made its own <html> and
  // <body> by then and folds these tags into them.
  expect(hasOwnDocumentShell("<p>a < b</p><body>")).toBe(true);
  expect(hasOwnDocumentShell("<title>R</title><html lang=zh><main>x</main></html>")).toBe(true);
  expect(hasOwnDocumentShell("<title>R</title>\n<!DOCTYPE html>\n<p>x</p>")).toBe(true);
});

test("an SVG's own <title> is not the page's title", () => {
  expect(readCanvasTitle('<svg viewBox="0 0 10 10"><title>Bytes per page</title><rect/></svg><title>JSON report</title>')).toBe("JSON report");
  expect(readCanvasTitle("<svg><title>Only a chart label</title></svg>")).toBeNull();
  expect(readCanvasTitle("<math><title>x</title></math><title>Real</title>")).toBe("Real");
});

test("non-ASCII text before a tag and unquoted values read as the browser reads them", () => {
  expect(readCanvasTitle("İ<title>Rapor</title>")).toBe("Rapor");
  expect(readCanvasTitle("<title>İstanbul</title>")).toBe("İstanbul");
  expect(readDeclaredViewport('İ<meta name="viewport" content="width=1280">')).toEqual({ width: 1280 });
  expect(readDeclaredViewport("<meta name=viewport content=width=1280/>")).toEqual({ invalid: "1280/" });
  expect(readDeclaredViewport('<meta name="viewport" content="width=1280" />')).toEqual({ width: 1280 });
  expect(readCanvasTitle("<title>Cut</title")).toBeNull();
});

test("iframe, xmp, noscript, noembed and noframes contents are text, and legacy references decode without a semicolon", () => {
  expect(readCanvasTitle("<xmp><title>Sample</title></xmp><title>Report</title>")).toBe("Report");
  expect(readCanvasTitle("<iframe><title>Fallback</title></iframe><title>Real</title>")).toBe("Real");
  expect(readDeclaredViewport("<noscript><meta name=viewport content=width=320></noscript>")).toBeNull();
  expect(hasOwnDocumentShell("<noembed><body></noembed><noframes><html></noframes>")).toBe(false);
  expect(readCanvasTitle("<title>R&amp D &copy 2026 &#169 &eacute</title>")).toBe("R& D © 2026 © é");
});
