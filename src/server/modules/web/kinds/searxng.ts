import { requestJson } from "../search-http.js";
import { optionalText, SearchFailure, searchItems, text, type SearchKind } from "../search-kind.js";

/** The user's own SearXNG instance, which answers JSON only when its
 *  settings allow that format. */
export const searxngKind: SearchKind = {
  id: "searxng",
  label: "SearXNG",
  description: "Your own instance. Its JSON output must be turned on.",
  fields: [{ key: "address", type: "url", label: "Address", required: true, placeholder: "https://search.example.com" }],
  describe: (setup) => `SearXNG · ${hostOf(setup.address ?? "")}`,
  async search(setup, query, ctx) {
    const base = (setup.address ?? "").replace(/\/+$/, "");
    let body: Record<string, unknown> | null;
    try {
      body = await requestJson(`${base}/search?q=${encodeURIComponent(query)}&format=json`, { method: "GET" }, ctx) as Record<string, unknown> | null;
    } catch (error) {
      if (error instanceof SearchFailure && error.status === 403) throw new SearchFailure("the instance refused JSON output (403)", 403);
      throw error;
    }
    const results = searchItems(body?.results, (entry) => ({
      title: text(entry.title),
      url: text(entry.url),
      excerpt: text(entry.content),
      ...optionalText("published", entry.publishedDate)
    }));
    return { results };
  }
};

function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}
