import { MIMEType } from "node:util";
import { Defuddle } from "defuddle/node";
import sniffHtmlEncoding from "html-encoding-sniffer";
import { parseHTML } from "linkedom";
import { PageError } from "./page-fetch.js";

export interface ConvertedPage {
  title?: string;
  author?: string;
  published?: string;
  site?: string;
  text: string;
}

const NO_TEXT = "The page has no readable text; it may need JavaScript.";
/** A text answer (not HTML) with nothing in it: nothing a script would add. */
const EMPTY_TEXT = "The page has no text.";
/** Read as text besides every text/* type: JSON, XML, and JavaScript under
 *  its older names. */
const TEXT_TYPES = new Set(["application/json", "application/xml", "application/javascript", "application/x-javascript"]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
/** How far into a page a charset declaration is looked for. */
const META_PRESCAN_BYTES = 2048;

/**
 * A page's main text. Markdown as it came; plain text, JSON and XML as text;
 * HTML through Defuddle (on a linkedom document) into Markdown with the
 * title, author, date and site it finds. `useAsync: false`: its site
 * extractors never call another service. Any other type is refused by name.
 */
export async function convertPage(input: { finalUrl: string; contentType: string; body: Uint8Array }): Promise<ConvertedPage> {
  const { mediaType, charset } = parseContentType(input.contentType);
  const kind = mediaType ? kindOf(mediaType) : sniff(input.body);
  if (kind === "markdown" || kind === "text") {
    const text = decode(input.body, charset);
    if (!text.trim()) throw new PageError(EMPTY_TEXT);
    return { text };
  }
  if (kind !== "html") throw new PageError(`web_fetch cannot read ${mediaType}.`);
  // As a browser finds it (the HTML Standard's sniffing): a byte order mark,
  // then the header's charset when it names a known encoding, then a
  // declaration in the page's first bytes, else UTF-8.
  const encoding = sniffHtmlEncoding(input.body, {
    ...(charset ? { transportLayerEncodingLabel: charset } : {}),
    defaultEncoding: "UTF-8",
    maxPrescanBytes: META_PRESCAN_BYTES
  });
  const html = decode(input.body, encoding);
  const result = await Defuddle(pageDocument(html), input.finalUrl, { markdown: true, useAsync: false });
  const text = (result.content ?? "").trim();
  if (!text) throw new PageError(NO_TEXT);
  return {
    text,
    ...present("title", result.title),
    ...present("author", result.author),
    ...present("published", result.published),
    ...present("site", statedSite(result))
  };
}

/** A linkedom document with no window behind it. linkedom's window reads
 *  (and writes) the process's globals, so a page would be laid out with
 *  whatever `getComputedStyle` the process has, if any: on the server none,
 *  in the tests the test DOM's. With no window Defuddle reads no styles,
 *  the same everywhere. */
function pageDocument(html: string): Document {
  const { document } = parseHTML(html);
  Object.defineProperty(document, "defaultView", { value: null, configurable: true });
  if (!document.styleSheets) Object.defineProperty(document, "styleSheets", { value: [], configurable: true });
  return document as unknown as Document;
}

/** The site's name as the page states it. With none stated Defuddle falls
 *  back to the author, then the address's domain; both are shown on lines of
 *  their own, so neither is given again as the site. */
function statedSite(result: { site?: string; author?: string; domain?: string }): string | undefined {
  const site = result.site?.trim();
  if (!site) return undefined;
  const same = (other: string | undefined) => Boolean(other) && other!.trim().toLowerCase() === site.toLowerCase();
  return same(result.author) || same(result.domain) ? undefined : site;
}

function present<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return typeof value === "string" && value.trim() ? ({ [key]: value.trim() } as Record<K, string>) : {};
}

function kindOf(mediaType: string): "markdown" | "text" | "html" | null {
  if (mediaType === "text/markdown") return "markdown";
  if (HTML_TYPES.has(mediaType)) return "html";
  if (mediaType.startsWith("text/") || TEXT_TYPES.has(mediaType) || mediaType.endsWith("+json") || mediaType.endsWith("+xml")) return "text";
  return null;
}

/** A server that names no type: HTML when it reads as HTML, else text. */
function sniff(body: Uint8Array): "html" | "text" {
  const head = new TextDecoder().decode(body.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") ? "html" : "text";
}

/** The header's type and charset, parsed as browsers parse a MIME type (a
 *  quoted parameter may hold `;` and `=`). A header that does not parse is
 *  taken as no header, as browsers take it. */
function parseContentType(value: string): { mediaType: string; charset?: string } {
  let parsed: MIMEType;
  try {
    parsed = new MIMEType(value);
  } catch {
    return { mediaType: "" };
  }
  const charset = parsed.params.get("charset");
  return { mediaType: parsed.essence, ...(charset ? { charset } : {}) };
}

function decode(body: Uint8Array, charset: string | undefined): string {
  if (charset) {
    try {
      return new TextDecoder(charset).decode(body);
    } catch {
      // An unknown label reads as UTF-8.
    }
  }
  return new TextDecoder().decode(body);
}
