import postcss, { CssSyntaxError, type AtRule, type ChildNode, type Declaration, type Node as CssNode, type Root, type Rule } from "postcss";
import valueParser from "postcss-value-parser";
import {
  CANVAS_DESKTOP_WIDTH_MAX,
  CANVAS_DESKTOP_WIDTH_MIN,
  CANVAS_FONT_SOURCES,
  CANVAS_SCRIPT_SOURCES,
  CANVAS_STYLE_SOURCES
} from "../../../shared/canvas-page.js";
import {
  SVG_NS,
  attributeOf,
  hasOwnDocumentShell,
  isHtmlElement,
  pageElements,
  parseCanvasPage,
  readCanvasTitle,
  readDeclaredViewport,
  textOf,
  type PageElement
} from "./canvas-html.js";
import { errorText } from "../../../shared/error-text.js";

/**
 * Advice returned at publish. Each finding is one sentence that
 * names the fix. None blocks a publish; only the size cap in the store does.
 * The page is read with real parsers (parse5 for HTML, postcss for CSS); the
 * judgements made on top of them are kept simple on purpose, so a rare
 * pattern can be misjudged. That is the price of advice that stays small.
 */
interface CanvasPageCheckOptions {
  /** A design's artboard: no <title> check (the canvas takes its title from
   *  canvas.json), no desktop-width check (its width is its board's), and no
   *  dark-only tokens (artboards never follow the theme). */
  artboard?: boolean;
}

export function checkCanvasPage(html: string, options: CanvasPageCheckOptions = {}): string[] {
  try {
    return pageWarnings(html, options);
  } catch (err) {
    // The checks only advise; a page they cannot read still publishes.
    const message = errorText(err);
    return [`The page checks could not run (${message}); the page was published unchecked.`];
  }
}

function pageWarnings(html: string, options: CanvasPageCheckOptions): string[] {
  const warnings: string[] = [];
  if (!options.artboard && !readCanvasTitle(html)) {
    warnings.push("No <title> in the first 8 KB. Put a <title> at the top of the file; it names the report.");
  }
  const doc = parseCanvasPage(html);
  if (hasOwnDocumentShell(doc)) {
    warnings.push("The file has its own <!doctype>, <html>, <head> or <body>. The viewer supplies the skeleton; write only the page content (<title>, <style>, markup, scripts).");
  }
  const elements = pageElements(doc);
  const { sheets, unreadable } = styleSheets(elements);
  for (const reason of unreadable) {
    warnings.push(`A <style> block has a syntax error (${reason}). Fix it; the checks could not read that block.`);
  }
  const loads = pageLoads(elements, sheets);
  // Where a page's own files live, and what the page is, in the agent's words.
  const beside = options.artboard ? "in the canvas folder" : "next to index.html";
  const page = options.artboard ? "an artboard" : "a report";
  const named = (load: PageLoad) => `${hostOf(load.url)} (${load.where})`;
  const blocked = new Set(loads.filter((load) => load.kind !== "frame" && !allowed(load.url, load.kind)).map(named));
  if (blocked.size) {
    warnings.push(`These resources are outside the allowlist and will be blocked: ${[...blocked].join(", ")}. Inline them, or put the file ${beside} and use a relative path.`);
  }
  const frames = new Set(loads.filter((load) => load.kind === "frame").map(named));
  if (frames.size) {
    const linkOut = options.artboard
      ? `link with <a href> to another artboard (a prototype link) or to another site (any other file ${beside} opens sandboxed: a PDF may show blank and a page runs no scripts)`
      : `link out with <a href> only to another site (a file ${beside} opens sandboxed: a PDF may show blank and a page runs no scripts)`;
    warnings.push(`Frames and plugins never load in ${page}: ${[...frames].join(", ")}. Put the content in ${options.artboard ? "the artboard" : "the report"} itself; ${linkOut}.`);
  }
  const refused = new Set(loads.filter((load) => load.cors && fromMandate(load.url)).map((load) => load.url));
  if (refused.size) {
    warnings.push(`Fonts and module scripts ${beside} cannot load: ${[...refused].join(", ")}. The sandboxed page asks for them with CORS and the ${options.artboard ? "canvas" : "report's"} folder refuses; embed a font as a data: URI (or use Google Fonts), and load a script with a classic <script src>.`);
  }
  // The page's colors cannot be judged from part of its CSS.
  if (!unreadable.length) {
    if (!hasPageBackground(elements, sheets)) {
      warnings.push("No background on body. The viewer paints its own ground behind the page; give body an explicit background from your tokens.");
    }
    const darkOnly = options.artboard ? [] : darkOnlyTokens(sheets);
    if (darkOnly.length) {
      warnings.push(`Defined only in a dark block: ${darkOnly.join(", ")}. Declare every token in the bare :root block first, or it has no value in light.`);
    }
  }
  if (options.artboard) {
    const themed = systemThemeUses(elements, sheets);
    if (themed.length) {
      warnings.push(`This artboard changes with the viewer's system theme (${themed.join(", ")}): an artboard is one look for everyone, so paint explicit colours and draw a dark variant as its own artboard.`);
    }
  }
  const declared = readDeclaredViewport(doc);
  if (!options.artboard && declared && "invalid" in declared) {
    warnings.push(`The viewport width "${declared.invalid}" is ignored: a desktop width must be a number from ${CANVAS_DESKTOP_WIDTH_MIN} to ${CANVAS_DESKTOP_WIDTH_MAX}.`);
  }
  return warnings;
}

interface StyleSheet {
  root: Root;
  /** A <style media> element's condition; null when the sheet always applies. */
  media: string | null;
  /** `<style type="text/tailwindcss">`: Tailwind's play CDN processes its @apply. */
  tailwind: boolean;
}

/** The page's <style> elements (inline SVG's style the page too), parsed. One
 *  postcss cannot read is reported by its reason. */
function styleSheets(elements: PageElement[]): { sheets: StyleSheet[]; unreadable: string[] } {
  const sheets: StyleSheet[] = [];
  const unreadable: string[] = [];
  for (const element of elements) {
    if (element.tagName !== "style" || !(isHtmlElement(element) || element.namespaceURI === SVG_NS)) continue;
    const media = (attributeOf(element, "media") ?? "").trim();
    const tailwind = /^text\/tailwindcss$/i.test((attributeOf(element, "type") ?? "").trim());
    try {
      sheets.push({ root: postcss.parse(textOf(element)), media: !media || /^(?:all|screen)$/i.test(media) ? null : media, tailwind });
    } catch (err) {
      unreadable.push(err instanceof CssSyntaxError ? `${err.reason}, line ${err.line}` : String(err));
    }
  }
  return { sheets, unreadable };
}

/** A style attribute's declarations. One the browser could not read either
 *  yields none. */
function inlineDeclarations(style: string): Declaration[] {
  try {
    return postcss.parse(style).nodes.filter((node): node is Declaration => node.type === "decl");
  } catch {
    return [];
  }
}

/** The rules and at-rules around a node, innermost first. */
function ancestorsOf(node: ChildNode): Array<Rule | AtRule> {
  const found: Array<Rule | AtRule> = [];
  let parent = node.parent as CssNode | undefined;
  while (parent && (parent.type === "rule" || parent.type === "atrule")) {
    found.push(parent as Rule | AtRule);
    parent = parent.parent as CssNode | undefined;
  }
  return found;
}

/** Inside any at-rule but @layer (@media, @supports, @container…), or in a
 *  <style media> element: it does not always apply. */
function conditional(node: ChildNode, sheet: StyleSheet): boolean {
  return sheet.media !== null || ancestorsOf(node).some((parent) => parent.type === "atrule" && parent.name.toLowerCase() !== "layer");
}

/** "frame": an <iframe>, <object> or <embed>, which the CSP never admits;
 *  it has its own warning. */
type ResourceKind = "script" | "style" | "font" | "media" | "frame";

/** Something the page asks the browser to fetch. `kind` decides which
 *  allowlist admits it; `cors` marks a font or a module script, which is
 *  fetched with CORS and so refused by the report's own folder (the sandboxed
 *  page's origin is opaque). */
interface PageLoad {
  url: string;
  kind: ResourceKind;
  /** The tag, "link" or "css" that names it, for the warning. */
  where: string;
  cors: boolean;
}

/** What a <link rel=preload as=…> fetches. */
const PRELOAD_KINDS: Record<string, ResourceKind> = { script: "script", style: "style", font: "font" };

const RESOURCE_TAGS = new Set(["script", "img", "source", "video", "audio", "iframe", "embed", "object", "track"]);
const FRAME_TAGS = new Set(["iframe", "embed", "object"]);
/** SVG elements that load what their href names. */
const SVG_HREF_TAGS = new Set(["image", "use", "feImage"]);

/** Everything the page fetches: element attributes (src, poster, data,
 *  srcset, a link's href, an SVG href), style attributes, and the
 *  stylesheets' @import targets, url()s and image-set() candidates. */
function pageLoads(elements: PageElement[], sheets: StyleSheet[]): PageLoad[] {
  const loads: PageLoad[] = [];
  const add = (url: string | undefined, kind: ResourceKind, where: string, cors = kind === "font") => {
    if (url?.trim()) loads.push({ url: url.trim(), kind, where, cors });
  };
  for (const element of elements) {
    const inline = attributeOf(element, "style");
    if (inline) for (const declaration of inlineDeclarations(inline)) for (const url of valueUrls(declaration.value)) add(url, "media", "css");
    if (element.namespaceURI === SVG_NS) {
      // `href` and `xlink:href` both arrive as "href".
      if (SVG_HREF_TAGS.has(element.tagName)) {
        for (const { name, value } of element.attrs) if (name === "href" && !value.startsWith("#")) add(value, "media", element.tagName);
      }
      continue;
    }
    if (!isHtmlElement(element)) continue;
    if (element.tagName === "link") {
      const rel = (attributeOf(element, "rel") ?? "").toLowerCase();
      const module = /\bmodulepreload\b/.test(rel);
      const kind: ResourceKind | null = module ? "script"
        : /\bstylesheet\b/.test(rel) ? "style"
          : /\bpreload\b/.test(rel) ? PRELOAD_KINDS[(attributeOf(element, "as") ?? "").trim().toLowerCase()] ?? "media"
            // An icon is not loaded: a frame has no tab to show it.
            : null;
      if (kind) add(attributeOf(element, "href"), kind, "link", module || kind === "font");
      continue;
    }
    if (!RESOURCE_TAGS.has(element.tagName)) continue;
    const kind: ResourceKind = element.tagName === "script" ? "script" : FRAME_TAGS.has(element.tagName) ? "frame" : "media";
    const module = kind === "script" && (attributeOf(element, "type") ?? "").trim().toLowerCase() === "module";
    for (const name of ["src", "poster", "data"]) add(attributeOf(element, name), kind, element.tagName, module);
    // srcset: comma-separated candidates, each a URL and an optional descriptor.
    for (const candidate of (attributeOf(element, "srcset") ?? "").split(",")) add(candidate.trim().split(/\s+/)[0], kind, element.tagName);
  }
  for (const { root } of sheets) {
    root.walkAtRules(/^import$/i, (rule) => {
      const target = valueParser(rule.params).nodes[0];
      add(target?.type === "function" && target.value.toLowerCase() === "url" ? target.nodes[0]?.value
        : target?.type === "string" ? target.value
          : undefined, "style", "css");
    });
    root.walkDecls((declaration) => {
      // A url() in @font-face loads a font; anywhere else, an image.
      const kind = ancestorsOf(declaration).some((parent) => parent.type === "atrule" && parent.name.toLowerCase() === "font-face") ? "font" : "media";
      for (const url of valueUrls(declaration.value)) add(url, kind, "css");
    });
  }
  return loads;
}

/** URLs a CSS value loads: url() arguments and image-set() candidates. A
 *  quoted string anywhere else is text (`content: "url(…)"`). */
function valueUrls(value: string): string[] {
  const urls: string[] = [];
  valueParser(value).walk((node) => {
    if (node.type !== "function") return;
    const name = node.value.toLowerCase();
    if (name === "url") {
      const argument = node.nodes[0];
      if (argument) urls.push(argument.value);
    }
    if (name === "image-set" || name === "-webkit-image-set") {
      for (const candidate of node.nodes) if (candidate.type === "string") urls.push(candidate.value);
    }
  });
  return urls;
}

/** Not another site, a data: or a blob: URL: a file next to index.html, or a
 *  root path on Mandate's own server. Either way the sandboxed page's CORS
 *  request for it is refused. */
function fromMandate(url: string): boolean {
  return !externalUrl(url) && !blockedScheme(url) && !/^(?:data|blob):/i.test(url);
}

/** A path from the site's root or the disk's (`/assets/x.png`, `/Users/…`):
 *  it resolves on Mandate's own origin, outside the report's folder. */
function rootPath(value: string): boolean {
  return /^\/(?!\/)/.test(value.trim());
}

/** Only http(s) and protocol-relative URLs leave the report's folder, parsed
 *  as a browser parses them (so "https:/host/x" is https://host/x). A
 *  protocol-relative one takes the viewer's protocol, and Mandate is served
 *  over http, so it resolves to http (which the https-only CSP blocks). */
function externalUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!/^(?:https?:|\/\/)/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, "http://relative.invalid/");
    return url.host === "relative.invalid" ? null : url;
  } catch {
    return null;
  }
}

/** An explicit scheme other than http(s), data: or blob: (file:, ftp:…)
 *  never loads in the viewer. */
function blockedScheme(value: string): string | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value.trim())?.[1]?.toLowerCase();
  return scheme && !["http", "https", "data", "blob"].includes(scheme) ? `${scheme}:` : null;
}

function hostOf(value: string): string {
  return externalUrl(value)?.host ?? blockedScheme(value) ?? value;
}

function allowed(value: string, kind: ResourceKind): boolean {
  if (blockedScheme(value) || rootPath(value)) return false;
  const url = externalUrl(value);
  if (!url) return true;
  const sources = kind === "script" ? CANVAS_SCRIPT_SOURCES
    : kind === "style" ? CANVAS_STYLE_SOURCES
      : kind === "font" ? CANVAS_FONT_SOURCES
        : [];
  return sources.some((source) => url.href.startsWith(source.endsWith("/") ? source : `${source}/`));
}

/** A selector's subject compound: body, with any classes, ids, attributes or
 *  pseudo-classes, at the end of the selector. Only body counts: the
 *  skeleton's reset paints body, which covers an html or :root background. */
const PAGE_SUBJECT = /(?:^|[\s>+~])body((?:[.#[:][^\s>+~]*)?)$/i;
const PSEUDO_ELEMENT = /::|:(?:before|after|first-line|first-letter|marker|selection|backdrop)\b/i;
/** Either explicit theme: what holds under one does not hold under the other. */
const THEME_SELECTOR = /\[data-theme\s*=\s*["']?(?:dark|light)["']?\]/i;

/** body itself (`body`, `html body`, `body.report`), not a descendant
 *  (`body .card`), a pseudo-element or one theme only. */
function isPageSelector(selector: string): boolean {
  const match = PAGE_SUBJECT.exec(selector.trim());
  return match !== null && !PSEUDO_ELEMENT.test(match[1] ?? "") && !THEME_SELECTOR.test(selector);
}

/**
 * Whether the page paints its own ground: a rule on body that always applies,
 * whose own declarations leave a color or an image, or a `style` / `bgcolor`
 * attribute on <body>. Kept simple: rules are
 * judged one at a time (a later rule clearing the background is not seen),
 * and :is()/:where() groups are not looked into.
 */
function hasPageBackground(elements: PageElement[], sheets: StyleSheet[]): boolean {
  // Tailwind's play CDN paints from a bg-* class or `@apply bg-*`.
  const tailwind = elements.some((element) =>
    isHtmlElement(element, "script") && /^https:\/\/cdn\.tailwindcss\.com(?:[/?#]|$)/i.test((attributeOf(element, "src") ?? "").trim()));
  for (const element of elements) {
    if (!isHtmlElement(element, "body")) continue;
    if (attributeOf(element, "bgcolor")) return true;
    if (paintsPage(inlineDeclarations(attributeOf(element, "style") ?? ""))) return true;
    if (tailwind && TAILWIND_BACKGROUND.test(attributeOf(element, "class") ?? "")) return true;
  }
  return sheets.some((sheet) => {
    let painted = false;
    sheet.root.walkRules((rule) => {
      if (painted || !rule.selectors.some(isPageSelector) || conditional(rule, sheet)) return;
      if (ancestorsOf(rule).some((parent) => parent.type === "rule" && THEME_SELECTOR.test(parent.selector))) return;
      painted = paintsPage(rule.nodes.filter((node): node is Declaration => node.type === "decl")) ||
        (tailwind && sheet.tailwind && rule.nodes.some((node) => node.type === "atrule" && node.name.toLowerCase() === "apply" && TAILWIND_BACKGROUND.test(node.params)));
    });
    return painted;
  });
}

/** A Tailwind background colour that always applies: no variant (so not
 *  `dark:bg-…`), and a colour (`bg-white`, `bg-stone-50`, `bg-brand-500/80`,
 *  `bg-[#fafaf9]`), not `bg-transparent` or a sizing utility. */
const TAILWIND_BACKGROUND = /(?:^|\s)bg-(?:white|black|\[[^\]\s]+\]|[a-z]+(?:-[a-z]+)*-\d{2,3})(?:\/\d{1,3})?(?=\s|$)/;

const IMAGE_FUNCTION = /(?:url|image-set|image|element|cross-fade|gradient)\(/i;

/** Whether the last background declarations leave a color or an image. The
 *  shorthand sets both layers: `background: #fff` is a color and no image. */
function paintsPage(declarations: Declaration[]): boolean {
  let color: string | undefined;
  let image: string | undefined;
  for (const { prop, value } of declarations) {
    const name = prop.toLowerCase();
    if (name === "background") {
      color = value;
      image = IMAGE_FUNCTION.test(value) ? value : "none";
    } else if (name === "background-color") color = value;
    else if (name === "background-image") image = value;
  }
  return paints(color) || paints(image);
}

function paints(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "" &&
    !/^(?:transparent|none|initial|unset|inherit|revert|revert-layer)$/i.test(value.trim());
}

const DARK_SELECTOR = /\[data-theme\s*=\s*["']?dark["']?\]/i;
const DARK_MEDIA = /prefers-color-scheme\s*:\s*dark/i;

/** How a page would follow the viewer's system theme, in a fixed order. An
 *  artboard gets no theme and must look the same to everyone:
 *  nothing pins its prefers-color-scheme, so each of these would change it. */
function systemThemeUses(elements: PageElement[], sheets: StyleSheet[]): string[] {
  const scheme = /prefers-color-scheme/i;
  const found = new Set<string>();
  const declarations = (decls: Iterable<Declaration>) => {
    for (const decl of decls) {
      if (decl.prop.toLowerCase() === "color-scheme" && /\bdark\b/i.test(decl.value)) found.add("color-scheme with dark");
      if (/\blight-dark\(/i.test(decl.value)) found.add("light-dark()");
    }
  };
  for (const sheet of sheets) {
    sheet.root.walkAtRules((rule) => { if (scheme.test(rule.params)) found.add("prefers-color-scheme in CSS"); });
    const decls: Declaration[] = [];
    sheet.root.walkDecls((decl) => { decls.push(decl); });
    declarations(decls);
  }
  for (const element of elements) {
    if (scheme.test(attributeOf(element, "media") ?? "")) found.add("a media attribute on prefers-color-scheme");
    // A `dark:` variant anywhere in a class's variant chain (`sm:dark:bg-…`).
    if ((attributeOf(element, "class") ?? "").split(/\s+/).some((name) => name.split(":").slice(0, -1).includes("dark"))) found.add("Tailwind dark: classes");
    if (element.tagName === "script" && attributeOf(element, "src") === undefined && scheme.test(textOf(element))) found.add("matchMedia on prefers-color-scheme");
    if (element.tagName === "meta" && /^color-scheme$/i.test((attributeOf(element, "name") ?? "").trim()) && /\bdark\b/i.test(attributeOf(element, "content") ?? "")) {
      found.add("color-scheme with dark");
    }
    const style = attributeOf(element, "style");
    if (style) declarations(inlineDeclarations(style));
  }
  return ["prefers-color-scheme in CSS", "a media attribute on prefers-color-scheme", "Tailwind dark: classes", "matchMedia on prefers-color-scheme", "color-scheme with dark", "light-dark()"]
    .filter((use) => found.has(use));
}

/** Tokens given a value under dark (a dark @media or <style media>, or a
 *  `[data-theme="dark"]` selector) but none in a bare `:root` or `html` rule
 *  that always applies: in light they have no value. */
function darkOnlyTokens(sheets: StyleSheet[]): string[] {
  const dark = new Set<string>();
  const always = new Set<string>();
  for (const sheet of sheets) {
    sheet.root.walkDecls(/^--/, (declaration) => {
      const parents = ancestorsOf(declaration);
      const underDark = DARK_MEDIA.test(sheet.media ?? "") || parents.some((parent) => parent.type === "atrule"
        ? parent.name.toLowerCase() === "media" && DARK_MEDIA.test(parent.params)
        // `:root:not([data-theme="dark"])` is not dark.
        : parent.selectors.some((selector) => DARK_SELECTOR.test(selector.replace(/:not\([^()]*\)/gi, ""))));
      if (underDark) dark.add(declaration.prop);
      const [rule, ...outer] = parents;
      const bareRoot = rule?.type === "rule" && rule.selectors.some((selector) => /^(?::root|html)$/i.test(selector.trim())) &&
        sheet.media === null && outer.every((parent) => parent.type === "atrule" && parent.name.toLowerCase() === "layer");
      if (bareRoot) always.add(declaration.prop);
    });
  }
  return [...dark].filter((name) => !always.has(name)).sort();
}
