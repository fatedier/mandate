import { requestJson } from "../search-http.js";
import { MAX_SEARCH_RESULTS, optionalText, searchItems, text, type SearchKind } from "../search-kind.js";

/** Exa's search API: results with the passages it judged most relevant. */
export const exaKind: SearchKind = {
  id: "exa",
  label: "Exa",
  description: "Exa's search API.",
  fields: [{ key: "apiKey", type: "secret", label: "API key", required: true }],
  describe: () => "Exa",
  async search(setup, query, ctx) {
    const body = await requestJson("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": setup.apiKey ?? "", "content-type": "application/json" },
      body: JSON.stringify({ query, type: "auto", numResults: MAX_SEARCH_RESULTS, contents: { highlights: true } })
    }, ctx) as Record<string, unknown> | null;
    const results = searchItems(body?.results, (entry) => ({
      title: text(entry.title),
      url: text(entry.url),
      excerpt: Array.isArray(entry.highlights) ? text(entry.highlights[0]) : "",
      ...optionalText("published", entry.publishedDate)
    }));
    return { results };
  }
};
