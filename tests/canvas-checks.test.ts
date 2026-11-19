import { expect, test } from "bun:test";
import { checkCanvasPage } from "../src/server/modules/canvas/canvas-checks.js";
import { CLEAN_ARTBOARD, CLEAN_REPORT } from "./helpers/canvas-pages.js";

test("a report that follows the contract has no warnings", () => {
  expect(checkCanvasPage(CLEAN_REPORT)).toEqual([]);
});

test("a missing <title> is flagged", () => {
  const warnings = checkCanvasPage(CLEAN_REPORT.replace("<title>Cache policy</title>", ""));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/^No <title> in the first 8 KB/);
});

test("a file with its own document shell is flagged", () => {
  const warnings = checkCanvasPage(`<!doctype html><html><head>${CLEAN_REPORT}</head></html>`);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/own <!doctype>, <html>, <head> or <body>/);
  // Also when the shell comes after the page's own <title>.
  expect(checkCanvasPage(`${CLEAN_REPORT}<html lang="zh"><body class="x"></body></html>`)).toEqual([expect.stringMatching(/own <!doctype>/)]);
});

test("resources outside the allowlist are listed with the tag that loads them", () => {
  const extra = [
    '<script src="https://esm.sh/react@18"></script>',
    '<script src="https://cdn.jsdelivr.net/gh/user/repo/x.js"></script>',
    '<script src="http://cdnjs.cloudflare.com/ajax/libs/a/1/a.js"></script>',
    '<img src="https://images.example.com/a.png">',
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/x@1/x.css">',
    "<style>.x { background: url(https://bg.example.com/bg.png); }</style>"
  ].join("");
  const warnings = checkCanvasPage(CLEAN_REPORT + extra);
  expect(warnings).toHaveLength(1);
  for (const piece of ["esm.sh (script)", "cdn.jsdelivr.net (script)", "cdnjs.cloudflare.com (script)", "images.example.com (img)", "cdn.jsdelivr.net (link)", "bg.example.com (css)"]) {
    expect(warnings[0]).toContain(piece);
  }
  expect(warnings[0]).not.toContain("github.com");
  expect(warnings[0]).not.toContain("fonts.googleapis.com");
});

test("a page without a background on body or html is flagged", () => {
  const without = CLEAN_REPORT.replace("background: var(--page); ", "");
  expect(checkCanvasPage(without)).toEqual([expect.stringMatching(/^No background on body/)]);
  expect(checkCanvasPage(without.replace("</style>", "body { background-color: var(--page); }</style>"))).toEqual([]);
});

test("a token defined only in a dark block is flagged by name", () => {
  const darkOnly = CLEAN_REPORT.replace(
    ':root[data-theme="dark"] { --page',
    ':root[data-theme="dark"] { --accent: #8fcaa9; --page'
  );
  const warnings = checkCanvasPage(darkOnly);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("--accent");
  expect(warnings[0]).not.toContain("--page");
});

test("an out-of-range desktop width is flagged as ignored", () => {
  const warnings = checkCanvasPage(`${CLEAN_REPORT}<meta name="viewport" content="width=320">`);
  expect(warnings).toEqual([expect.stringContaining('The viewport width "320" is ignored')]);
  expect(checkCanvasPage(`${CLEAN_REPORT}<meta name="viewport" content="width=1280">`)).toEqual([]);
});

test("markup inside scripts and comments is not a resource or a style", () => {
  const page = CLEAN_REPORT +
    "<script>const row = '<img src=\"https://example.com/x.png\">';</script>" +
    '<!-- <style>:root[data-theme="dark"] { --ghost: #000; }</style> -->';
  expect(checkCanvasPage(page)).toEqual([]);
});

test("preloads are judged by their destination", () => {
  const allowed = '<link rel="preload" as="script" href="https://cdnjs.cloudflare.com/ajax/libs/a/1/a.js">' +
    '<link rel="preload" as="font" href="https://fonts.gstatic.com/s/x.woff2" crossorigin>';
  expect(checkCanvasPage(CLEAN_REPORT + allowed)).toEqual([]);
  const warnings = checkCanvasPage(CLEAN_REPORT + '<link rel="preload" as="image" href="https://images.example.com/a.png">');
  expect(warnings).toEqual([expect.stringContaining("images.example.com (link)")]);
});

test("srcset candidates and inline style URLs are checked", () => {
  const warnings = checkCanvasPage(CLEAN_REPORT +
    '<img src="a.png" srcset="a.png 1x, https://cdn.example.com/a@2x.png 2x">' +
    '<div style="background-image:url(https://inline.example.com/x.png)"></div>');
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("cdn.example.com (img)");
  expect(warnings[0]).toContain("inline.example.com (css)");
});

test("each CSS URL is judged by what it loads", () => {
  const blocked = CLEAN_REPORT.replace("</style>",
    '@import url("https://fonts.gstatic.com/x.css");\n.x { background: url(https://fonts.gstatic.com/a.png); }\n</style>');
  const warnings = checkCanvasPage(blocked);
  expect(warnings).toEqual([expect.stringContaining("fonts.gstatic.com (css)")]);
  const fontFace = CLEAN_REPORT.replace("</style>", "@font-face { font-family: X; src: url(https://fonts.gstatic.com/s/x.woff2); }\n</style>");
  expect(checkCanvasPage(fontFace)).toEqual([]);
});

test("only a rule on body itself paints the page", () => {
  const without = CLEAN_REPORT.replace("background: var(--page); ", "");
  expect(checkCanvasPage(without.replace("</style>", "body .card { background: #fff; }\n</style>"))).toEqual([expect.stringMatching(/^No background on body/)]);
  expect(checkCanvasPage(without.replace("</style>", "html body { background: var(--page); }\n</style>"))).toEqual([]);
  expect(checkCanvasPage(without.replace("</style>", "body.report { background: var(--page); }\n</style>"))).toEqual([]);
});

test("a token defined in a component and in dark, but not in bare :root, is flagged", () => {
  const scoped = CLEAN_REPORT.replace("</style>", '.card { --accent: red; }\n:root[data-theme="dark"] { --accent: blue; }\n</style>');
  expect(checkCanvasPage(scoped)).toEqual([expect.stringContaining("--accent")]);
});

const withBody = (rule: string) => CLEAN_REPORT.replace("body { background: var(--page); color: var(--ink); padding-inline: 16px; }", rule);

// Which rules paint the page background. Each row's rule replaces the page's
// own body rule; one that does not paint draws the "No background on body"
// warning, and one that does leaves the page with none.
const bodyBackgrounds: { name: string; rule: string; paints: boolean }[] = [
  { name: "a body rule with nested rules inside it still paints the page",
    rule: "body { background: var(--page); color: var(--ink); &.compact { padding: 0; } }", paints: true },
  { name: "a gradient on body paints the page", rule: "body { background-image: linear-gradient(#fff, #eee); }", paints: true },
  { name: "a pseudo-element's background does not paint the page", rule: "body::before { background: var(--page); }", paints: false },
  { name: "a body background only in a dark-mode media block does not paint the page",
    rule: "@media (prefers-color-scheme: dark) { body { background: var(--page); } }", paints: false },
  { name: "a transparent background does not paint the page", rule: "body { background: transparent; }", paints: false },
  { name: "a none background does not paint the page", rule: "body { background: none; }", paints: false },
  // A page background must hold at every width.
  { name: "a body background only from a minimum width up does not paint the page",
    rule: "@media (min-width: 900px) { body { background: #fff; } }", paints: false },
  // The last declaration in a rule decides.
  { name: "a later transparent background in the same rule undoes the colour before it",
    rule: "body { background: #fff; background: transparent; }", paints: false },
  { name: "a later background-color in the same rule paints over a transparent background",
    rule: "body { background: transparent; background-color: var(--page); }", paints: true },
  // (A "</style>" inside the string would close the <style> element in HTML
  // itself, so the braces here stand without one.)
  { name: "braces inside quoted CSS values are not rules",
    rule: "body { background: url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><text>{ok; done}</text></svg>\"); }", paints: true },
  // Background color and image are separate layers.
  { name: "a background-image of none leaves the background colour painting",
    rule: "body { background-color: var(--page); background-image: none; }", paints: true },
  { name: "a body background only under the dark theme does not paint the page",
    rule: "[data-theme=\"dark\"] body { background: var(--page); }", paints: false }
];

test.each(bodyBackgrounds)("$name", ({ rule, paints }) => {
  expect(checkCanvasPage(withBody(rule))).toEqual(paints ? [] : [expect.stringMatching(/^No background on body/)]);
});

test("a nested dark override under :root is a dark definition of a light token", () => {
  const nested = CLEAN_REPORT.replace(':root { --page: #fbfbf9; --ink: #1f1b16; }',
    ':root { --page: #fbfbf9; --ink: #1f1b16; --line: #ddd; &[data-theme="dark"] { --line: #333; } }');
  expect(checkCanvasPage(nested)).toEqual([]);
});

test("SVG images, quoted angle brackets and example text are read as the browser reads them", () => {
  const svg = checkCanvasPage(`${CLEAN_REPORT}<svg><image href="https://images.example.com/logo.png"/></svg>`);
  expect(svg).toEqual([expect.stringContaining("images.example.com (image)")]);
  const quoted = checkCanvasPage(`${CLEAN_REPORT}<img alt="A > B" src="https://images.example.com/a.png">`);
  expect(quoted).toEqual([expect.stringContaining("images.example.com (img)")]);
  expect(checkCanvasPage(`${CLEAN_REPORT}<pre>Use style="background:url(https://example.com/x.png)"</pre>`)).toEqual([]);
});

test("quoted CSS URLs with parentheses and image-set candidates are checked", () => {
  const page = CLEAN_REPORT.replace("</style>",
    '.a { background: url("https://paren.example.com/a(b).png"); }\n' +
    '.b { background-image: image-set("https://set.example.com/hero.png" 1x, url(hero@2x.png) 2x); }\n</style>');
  const warnings = checkCanvasPage(page);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("paren.example.com (css)");
  expect(warnings[0]).toContain("set.example.com (css)");
});

test("protocol-relative CDN URLs are flagged: Mandate is served over http, and the CSP admits https only", () => {
  const warnings = checkCanvasPage(`${CLEAN_REPORT}<script src="//cdnjs.cloudflare.com/ajax/libs/a/1/a.js"></script>`);
  expect(warnings).toEqual([expect.stringContaining("cdnjs.cloudflare.com (script)")]);
});

test("light tokens only inside a light-mode media block have no value when light is chosen on a dark OS", () => {
  const page = CLEAN_REPORT.replace(':root { --page: #fbfbf9; --ink: #1f1b16; }',
    '@media (prefers-color-scheme: light) { :root { --page: #fbfbf9; --ink: #1f1b16; } }');
  expect(checkCanvasPage(page)).toEqual([expect.stringContaining("--ink, --page")]);
});

test("deeply nested selector groups do not break the checks", () => {
  const deep = `${":is(".repeat(20000)}body${")".repeat(20000)} { background: red; }`;
  expect(() => checkCanvasPage(withBody(deep))).not.toThrow();
});

test("selector lists are judged selector by selector", () => {
  const shared = CLEAN_REPORT.replace("</style>", ':root, :root[data-theme="dark"] { --line: #111; }\n</style>');
  expect(checkCanvasPage(shared)).toEqual([]);
});

test("resources with other explicit schemes are flagged by scheme", () => {
  const warnings = checkCanvasPage(`${CLEAN_REPORT}<img src="file:///tmp/chart.png">`);
  expect(warnings).toEqual([expect.stringContaining("file: (img)")]);
});

test("a background on html or :root does not count: the skeleton's reset paints body over it", () => {
  expect(checkCanvasPage(withBody("html { background: #fff; }"))).toEqual([expect.stringMatching(/^No background on body/)]);
  expect(checkCanvasPage(withBody(":root { background: var(--page); }"))).toEqual([expect.stringMatching(/^No background on body/)]);
  expect(checkCanvasPage(`${withBody("body { color: red; }")}<div></div>`.replace("<main", '<main style="background: #fff"'))).toEqual([expect.stringMatching(/^No background on body/)]);
});

test("a <style media> element is conditional CSS, and a single-slash https URL is still external", () => {
  const darkStyle = CLEAN_REPORT.replace("</style>", '</style><style media="(prefers-color-scheme: dark)">:root { --glow: #333; } body { background: #000; }</style>');
  expect(checkCanvasPage(darkStyle)).toEqual([expect.stringContaining("--glow")]);
  expect(checkCanvasPage(withBody("body { color: red; }").replace("</style>", '</style><style media="screen and (min-width: 900px)">body { background: #fff; }</style>')))
    .toEqual([expect.stringMatching(/^No background on body/)]);
  expect(checkCanvasPage(`${CLEAN_REPORT}<script src="https:/evil.example.com/lib.js"></script>`)).toEqual([expect.stringContaining("evil.example.com (script)")]);
});

test("declarations directly inside a nested @media are conditional, and a url() inside a string is text", () => {
  const nestedToken = CLEAN_REPORT.replace("</style>", ":root { @media (prefers-color-scheme: dark) { --accent: red; } }\n</style>");
  expect(checkCanvasPage(nestedToken)).toEqual([expect.stringContaining("--accent")]);
  const nestedImage = CLEAN_REPORT.replace("</style>", ".x { @media (min-width: 1px) { background: url(https://img.example.com/a.png); } }\n</style>");
  expect(checkCanvasPage(nestedImage)).toEqual([expect.stringContaining("img.example.com (css)")]);
  const label = CLEAN_REPORT.replace("</style>", '.label::after { content: "url(https://example.com/x)"; }\n</style>');
  expect(checkCanvasPage(label)).toEqual([]);
});

test("a light-only background is conditional, a color shorthand is no image, and image-set() in a string is text", () => {
  expect(checkCanvasPage(withBody('html[data-theme="light"] body { background: white; }'))).toEqual([expect.stringMatching(/^No background on body/)]);
  expect(checkCanvasPage(withBody("body { background: #fff; background-color: transparent; }"))).toEqual([expect.stringMatching(/^No background on body/)]);
  const label = CLEAN_REPORT.replace("</style>", ".code::after { content: \"image-set('https://example.com/a.png' 1x)\"; }\n</style>");
  expect(checkCanvasPage(label)).toEqual([]);
});

test("the checks stay fast on a large inline stylesheet", () => {
  const rule = ".c{width:calc(var(--w) + 1px);height:calc(var(--h) * 2);background:url(\"a.png\")}\n";
  const css = rule.repeat(Math.ceil(500_000 / rule.length));
  const started = performance.now();
  checkCanvasPage(CLEAN_REPORT.replace("</style>", `${css}</style>`));
  expect(performance.now() - started).toBeLessThan(1500);
});

test("fonts and module scripts next to index.html are flagged: their CORS requests are refused", () => {
  const local = CLEAN_REPORT.replace("</style>", '@font-face { font-family: Face; src: url("face.woff2"); }\n</style>') +
    '<script type="module" src="app.js"></script>';
  const warnings = checkCanvasPage(local);
  expect(warnings).toEqual([expect.stringContaining("face.woff2")]);
  expect(warnings[0]).toContain("app.js");
  expect(warnings[0]).toMatch(/^Fonts and module scripts next to index\.html cannot load/);
  // Preloads of them are CORS requests too, and may be all the page shows
  // (the @font-face can sit in a stylesheet file next to index.html).
  const preloads = checkCanvasPage(`${CLEAN_REPORT}<link rel="modulepreload" href="./chunk.js"><link rel="preload" as="font" href="face.woff2" crossorigin><link rel="preload" as="image" href="hero.png">`);
  expect(preloads).toEqual([expect.stringContaining("./chunk.js, face.woff2.")]);
});

test("a <style> block the checks cannot read is reported with the parser's reason", () => {
  const broken = CLEAN_REPORT.replace("</style>", ".x { color: red;\n</style>");
  expect(checkCanvasPage(broken)).toEqual([expect.stringMatching(/^A <style> block has a syntax error \(Unclosed block, line \d+\)/)]);
  // A broken style attribute is dropped by the browser too: nothing to report.
  expect(checkCanvasPage(`${CLEAN_REPORT}<div style="color: red; background: url(https://a.example.com/x.png">x</div>`)).toEqual([]);
});

test("an inline SVG's <style> styles the page too, and a quoted URL outside url() is text", () => {
  const svgStyle = `${CLEAN_REPORT}<svg><style>.mark { fill: url(https://svg.example.com/p.svg#g); }</style></svg>`;
  expect(checkCanvasPage(svgStyle)).toEqual([expect.stringContaining("svg.example.com (css)")]);
  const text = CLEAN_REPORT.replace("</style>", '.cite::after { content: "https://images.example.com/x.png"; }\n</style>');
  expect(checkCanvasPage(text)).toEqual([]);
});

test("a page background nested under one theme is conditional, and :not(dark) is not dark", () => {
  expect(checkCanvasPage(withBody('[data-theme="light"] { body { background: #fff; } }'))).toEqual([expect.stringMatching(/^No background on body/)]);
  expect(checkCanvasPage(CLEAN_REPORT.replace("</style>", ':root:not([data-theme="dark"]) { --accent: red; }\n</style>'))).toEqual([]);
});

test("with Tailwind loaded, a bg-* class or @apply on body is the page background", () => {
  const without = CLEAN_REPORT.replace("background: var(--page); ", "");
  const tailwind = '<script src="https://cdn.tailwindcss.com"></script>';
  // The contract's way: page content only, the body styled with @apply.
  expect(checkCanvasPage(`${without}${tailwind}<style type="text/tailwindcss">body { @apply bg-stone-50 dark:bg-stone-900; }</style>`)).toEqual([]);
  // A <body> tag of its own draws the shell warning, but its class paints.
  expect(checkCanvasPage(`${without}${tailwind}<body class="min-h-screen bg-stone-50 dark:bg-stone-900"></body>`))
    .toEqual([expect.stringMatching(/own <!doctype>/)]);
  // Without Tailwind neither paints anything.
  expect(checkCanvasPage(`${without}<body class="bg-stone-50"></body>`))
    .toEqual([expect.stringMatching(/own <!doctype>/), expect.stringMatching(/^No background on body/)]);
  // Only an unconditional colour paints the light page: not a dark-only one,
  // not transparent, not a sizing utility.
  const shell = expect.stringMatching(/own <!doctype>/);
  const bare = expect.stringMatching(/^No background on body/);
  for (const unpainted of ["dark:bg-slate-900", "bg-transparent", "bg-cover"]) {
    expect(checkCanvasPage(`${without}${tailwind}<body class="${unpainted}"></body>`)).toEqual([shell, bare]);
  }
  for (const painted of ["bg-white dark:bg-slate-900", "bg-[#fafaf9]", "bg-brand-50"]) {
    expect(checkCanvasPage(`${without}${tailwind}<body class="${painted}"></body>`)).toEqual([shell]);
  }
  // Tailwind processes @apply only in its own style blocks.
  expect(checkCanvasPage(`${without}${tailwind}<style>body { @apply bg-stone-50; }</style>`)).toEqual([bare]);
});

test("a root-relative or absolute path is outside the report's folder", () => {
  const warnings = checkCanvasPage(`${CLEAN_REPORT}<img src="/Users/user/report/chart.png"><img src="/assets/logo.png">`);
  expect(warnings).toEqual([expect.stringContaining("/Users/user/report/chart.png (img)")]);
  expect(warnings[0]).toContain("/assets/logo.png (img)");
  // A font or module there also gets the CORS advice: moving it next to
  // index.html alone would not make it load.
  const font = checkCanvasPage(CLEAN_REPORT.replace("</style>", '@font-face { font-family: F; src: url("/fonts/f.woff2"); }\n</style>'));
  expect(font).toEqual([expect.stringContaining("/fonts/f.woff2 (css)"), expect.stringMatching(/^Fonts and module scripts next to index\.html cannot load: \/fonts\/f\.woff2\./)]);
});

test("frames and plugins never load, even from the report's folder, and the warning says what to do instead", () => {
  const warnings = checkCanvasPage(`${CLEAN_REPORT}<iframe src="chart.html"></iframe><object data="doc.pdf"></object><embed src="clip.svg"><iframe srcdoc="<p>x</p>"></iframe><iframe src="https://www.youtube.com/embed/x"></iframe>`);
  // One warning, with the other sites' frames in it too: not the allowlist's.
  expect(warnings).toEqual([expect.stringMatching(/^Frames and plugins never load in a report: chart\.html \(iframe\), doc\.pdf \(object\), clip\.svg \(embed\), www\.youtube\.com \(iframe\)\. Put the content in the report itself; link out with <a href> only to another site \(a file next to index\.html opens sandboxed/)]);
});

test("an icon link is not a load: the frame never fetches icons", () => {
  expect(checkCanvasPage(`${CLEAN_REPORT}<link rel="icon" href="https://cdn.example.com/favicon.ico">`)).toEqual([]);
});

test("an artboard is not checked for a title, a desktop width or dark-only tokens", () => {
  const artboard = CLEAN_ARTBOARD
    .replace("</style>", ':root[data-theme="dark"] { --accent: #8fcaa9; }\n</style>') +
    '<meta name="viewport" content="width=320">';
  expect(checkCanvasPage(artboard, { artboard: true })).toEqual([]);
  // A report with the same page gets all three.
  expect(checkCanvasPage(artboard)).toHaveLength(3);
  // Everything else still applies to an artboard.
  expect(checkCanvasPage(`${CLEAN_ARTBOARD}<img src="https://images.example.com/a.png">`, { artboard: true }))
    .toEqual([expect.stringContaining("images.example.com (img)")]);
});

test("an artboard's warnings speak of the canvas folder and the artboard, never of index.html or a report", () => {
  const page = `${CLEAN_REPORT}<img src="https://images.example.com/a.png"><iframe src="https://example.com/"></iframe>` +
    '<link rel="stylesheet" href="fonts.css"><script type="module" src="app.js"></script>';
  const artboard = checkCanvasPage(page, { artboard: true });
  expect(artboard.length).toBeGreaterThanOrEqual(3);
  for (const warning of artboard) {
    expect(warning.includes("index.html") || warning.includes("report")).toBe(false);
  }
  expect(artboard.some((warning) => warning.includes("in the canvas folder"))).toBe(true);
  expect(artboard.some((warning) => warning.includes("never load in an artboard"))).toBe(true);
  // A link to another artboard is a prototype link, and the warning says so.
  expect(artboard.some((warning) => warning.includes("never load in an artboard") && warning.includes("another artboard"))).toBe(true);
  // A report's say what they said.
  const report = checkCanvasPage(page);
  expect(report.some((warning) => warning.includes("next to index.html"))).toBe(true);
  expect(report.some((warning) => warning.includes("never load in a report"))).toBe(true);
});

test("an artboard that would change with the viewer's system theme is warned about, naming each way it does", () => {
  const warn = (extra: string) => checkCanvasPage(`${CLEAN_ARTBOARD}${extra}`, { artboard: true }).filter((warning) => warning.includes("system theme"));
  expect(warn("<style>@media (prefers-color-scheme: dark) { body { background: #000; } }</style>")).toEqual([
    "This artboard changes with the viewer's system theme (prefers-color-scheme in CSS): an artboard is one look for everyone, so paint explicit colours and draw a dark variant as its own artboard."
  ]);
  expect(warn('<link rel="stylesheet" href="dark.css" media="(prefers-color-scheme: dark)">')[0]).toContain("(a media attribute on prefers-color-scheme)");
  expect(warn('<p class="text-black dark:text-white">x</p>')[0]).toContain("(Tailwind dark: classes)");
  // After other variants too; a class that merely contains "dark" is not one.
  expect(warn('<p class="sm:dark:bg-slate-900 hover:dark:text-white">x</p>')[0]).toContain("(Tailwind dark: classes)");
  expect(warn('<p class="darkroom bg-dark-900 text-dark">x</p>')).toEqual([]);
  expect(warn('<script>if (matchMedia("(prefers-color-scheme: dark)").matches) document.body.className = "dark";</script>')[0]).toContain("(matchMedia on prefers-color-scheme)");
  expect(warn("<style>:root { color-scheme: light dark; } p { color: light-dark(#111, #eee); }</style>")[0]).toContain("(color-scheme with dark, light-dark())");
  // An artboard in one look is not warned about; a report is theme-aware by design and never is.
  expect(warn("<style>body { background: #fff; color: #111; }</style>")).toEqual([]);
  expect(checkCanvasPage(`${CLEAN_REPORT}<style>@media (prefers-color-scheme: dark) { body { background: #000; } }</style>`).some((warning) => warning.includes("system theme"))).toBe(false);
});
