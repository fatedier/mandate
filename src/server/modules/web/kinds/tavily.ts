import { requestJson } from "../search-http.js";
import { MAX_SEARCH_RESULTS, optionalText, searchItems, text, type SearchKind } from "../search-kind.js";

/** Tavily's search API: one credit a search at basic depth, with an answer. */
export const tavilyKind: SearchKind = {
  id: "tavily",
  label: "Tavily",
  description: "Tavily's search API.",
  fields: [{ key: "apiKey", type: "secret", label: "API key", required: true }],
  describe: () => "Tavily",
  async search(setup, query, ctx) {
    const body = await requestJson("https://api.tavily.com/search", {
      method: "POST",
      headers: { authorization: `Bearer ${setup.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query, search_depth: "basic", include_answer: "basic", max_results: MAX_SEARCH_RESULTS })
    }, ctx) as Record<string, unknown> | null;
    const results = searchItems(body?.results, (entry) => ({
      title: text(entry.title),
      url: text(entry.url),
      excerpt: text(entry.content),
      ...optionalText("published", entry.published_date)
    }));
    return { ...optionalText("answer", body?.answer), results };
  }
};
