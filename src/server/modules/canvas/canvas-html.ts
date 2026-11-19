/**
 * A report page read as the browser reads it. parse5 implements the HTML
 * parsing algorithm, so a tag inside a comment, a script string, an attribute
 * or a <template> is not one, entities decode as in HTML, <noscript> is text
 * (as with scripting on), and an SVG <title> is not the page's.
 */

import { defaultTreeAdapter, parse, type DefaultTreeAdapterMap } from "parse5";
import {
  CANVAS_TITLE_MAX_CHARS,
  CANVAS_TITLE_SCAN_BYTES,
  parseViewportWidth,
  type DeclaredViewport
} from "../../../shared/canvas-page.js";

type PageDocument = DefaultTreeAdapterMap["document"];
export type PageElement = DefaultTreeAdapterMap["element"];
type PageNode = DefaultTreeAdapterMap["node"];

const HTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";

/** Documents with a shell tag the parser folded into what it had already
 *  built: a doctype, <html> or <body> after other content. */
const foldedShells = new WeakSet<PageDocument>();

export function parseCanvasPage(html: string): PageDocument {
  let folded = false;
  const doc = parse(html, {
    sourceCodeLocationInfo: true,
    // A late <html> or <body> start tag hands its attributes to the element
    // the parser made itself (never inside a <template>); a late doctype is
    // a parse error. Neither leaves a trace in the tree.
    treeAdapter: {
      ...defaultTreeAdapter,
      adoptAttributes(recipient, attrs) {
        folded = true;
        defaultTreeAdapter.adoptAttributes(recipient, attrs);
      }
    },
    onParseError: (error) => {
      if (error.code === "misplaced-doctype") folded = true;
    }
  });
  if (folded) foldedShells.add(doc);
  return doc;
}

const asDocument = (page: string | PageDocument) => (typeof page === "string" ? parseCanvasPage(page) : page);

/** Every element, in tree order. A <template>'s contents are a fragment of
 *  their own, not part of the page. */
export function pageElements(doc: PageDocument): PageElement[] {
  const elements: PageElement[] = [];
  // Iterative: a generated page can nest deeper than the call stack.
  const stack: PageNode[] = [...doc.childNodes].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (!("tagName" in node)) continue;
    elements.push(node);
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
  }
  return elements;
}

export function isHtmlElement(element: PageElement, name?: string): boolean {
  return element.namespaceURI === HTML_NS && (name === undefined || element.tagName === name);
}

/** An attribute's value, entity-decoded; SVG's `xlink:href` is `href`. */
export function attributeOf(element: PageElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

/** The text of a <title> or a <style>: its text children (CDATA inside SVG
 *  arrives as text). */
export function textOf(element: PageElement): string {
  return element.childNodes.map((node) => (node.nodeName === "#text" ? (node as DefaultTreeAdapterMap["textNode"]).value : "")).join("");
}

/** The page's name: its <title>, which must end within the first 8 KB
 *  (bytes), whitespace collapsed, cut to 120 characters. Null when there is
 *  none. */
export function readCanvasTitle(html: string): string | null {
  // Each character is at least one byte, so the first 8 K characters hold
  // the first 8 KB: only those are encoded, not the whole page.
  const head = new TextDecoder().decode(new TextEncoder().encode(html.slice(0, CANVAS_TITLE_SCAN_BYTES)).subarray(0, CANVAS_TITLE_SCAN_BYTES));
  const title = pageElements(parseCanvasPage(head)).find((element) => isHtmlElement(element, "title"));
  // A title cut off by the 8 KB limit has no end tag of its own.
  if (!title?.sourceCodeLocation?.endTag) return null;
  const text = textOf(title).replace(/\s+/g, " ").trim();
  return text ? [...text].slice(0, CANVAS_TITLE_MAX_CHARS).join("") : null;
}

/** The desktop width a report declares with
 *  `<meta name="viewport" content="width=1280">`: the first viewport meta that
 *  names a width decides. */
export function readDeclaredViewport(page: string | PageDocument): DeclaredViewport {
  for (const element of pageElements(asDocument(page))) {
    if (!isHtmlElement(element, "meta") || attributeOf(element, "name")?.toLowerCase() !== "viewport") continue;
    const declared = parseViewportWidth(attributeOf(element, "content") ?? "");
    if (declared) return declared;
  }
  return null;
}

/** True when the file writes its own document shell: a doctype, or an
 *  <html>, <head> or <body> tag, where the parser used it (tags it creates by
 *  itself carry no source location) or folded it into its own. */
export function hasOwnDocumentShell(page: string | PageDocument): boolean {
  const doc = asDocument(page);
  if (foldedShells.has(doc) || doc.childNodes.some((node) => node.nodeName === "#documentType")) return true;
  return pageElements(doc).some((element) =>
    isHtmlElement(element) && ["html", "head", "body"].includes(element.tagName) && element.sourceCodeLocation != null);
}
