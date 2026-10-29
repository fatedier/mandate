import { z } from "zod";
import { TOOL_CALL_STOPPED, type ToolDefinition } from "../agent/tool-registry.js";
import { globalHttpClient, type HttpClient } from "../../platform/http/http-client.js";
import { formatFetchText, removeMarkerLookAlikes } from "../../../shared/web-tool-text.js";
import { fetchPage } from "./page-fetch.js";
import { convertPageAway } from "./page-convert-away.js";
import type { KeptPage, PageCopies } from "./page-copies.js";

/** How much of a page's text one call shows: with Mandate's lines and the
 *  page's own fields it stays under the 30,000 characters a tool result
 *  shows the model inline (MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS). */
export const WEB_FETCH_WINDOW = 16_000;

const params = z.object({
  url: z.string().describe("The page to read."),
  offset: z.number().int().min(0).optional()
    .describe("Where in the page's text to start, in characters (default 0). Pass the offset the previous call gave to read on.")
});

/** The id of one result's markers: 16 hex characters from a secure source. */
export function newWebTextId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildWebFetchTool(deps: {
  http?: HttpClient;
  copies: PageCopies;
  randomId: () => string;
  timeoutMs?: number;
}): ToolDefinition<z.infer<typeof params>, string> {
  const http = deps.http ?? globalHttpClient;
  return {
    name: "web_fetch",
    description: "Read a web page (http or https). Returns its main text as Markdown, a window at a time. The first lines give the page's title, its author, date and site when the page states them, its address after redirects, the length of its text and the offset to read on from.",
    parameters: params,
    handler: async ({ url, offset = 0 }, ctx) => {
      if (ctx.signal?.aborted) throw new Error(TOOL_CALL_STOPPED);
      // Reading on comes from the copy read first; the start of a page is
      // always read afresh.
      let page = offset > 0 ? deps.copies.get(url) : null;
      if (!page) {
        page = await read(url, http, ctx.signal, deps.timeoutMs);
        if (ctx.signal?.aborted) throw new Error(TOOL_CALL_STOPPED);
        deps.copies.set(url, page);
      }
      const length = page.text.length;
      if (offset > 0 && offset >= length) {
        throw new Error(`Offset ${offset} is past the end of the text (${length.toLocaleString("en-US")} characters).`);
      }
      let end = Math.min(length, offset + WEB_FETCH_WINDOW);
      // Never end a window inside a surrogate pair.
      if (end < length && isHighSurrogate(page.text.charCodeAt(end - 1))) end -= 1;
      const kept = page;
      const id = deps.randomId();
      const format = (windowEnd: number) => formatFetchText({
        finalUrl: kept.finalUrl,
        length,
        start: offset,
        end: windowEnd,
        cut: kept.cut,
        ...(kept.title ? { title: kept.title } : {}),
        ...(kept.author ? { author: kept.author } : {}),
        ...(kept.published ? { published: kept.published } : {}),
        ...(kept.site ? { site: kept.site } : {}),
        window: kept.text.slice(offset, windowEnd)
      }, id);
      // A window is well under the inline limit (tool-output-spool.ts), so
      // it is returned whole, however many lines it has.
      return format(end);
    }
  };
}

async function read(url: string, http: HttpClient, signal: AbortSignal | undefined, timeoutMs: number | undefined): Promise<KeptPage> {
  try {
    const fetched = await fetchPage(url, { http, ...(signal ? { signal } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
    const converted = await convertPageAway(fetched, signal);
    // Cleaned before it is cut into windows: a look-alike marker grows when
    // replaced, and the offsets count the text as the agent is shown it.
    return { finalUrl: fetched.finalUrl, cut: fetched.cut, ...converted, text: removeMarkerLookAlikes(converted.text) };
  } catch (error) {
    if (signal?.aborted) throw new Error(TOOL_CALL_STOPPED);
    throw error;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
