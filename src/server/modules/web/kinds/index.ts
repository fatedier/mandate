import type { SearchKind } from "../search-kind.js";
import { exaKind } from "./exa.js";
import { modelSearchKind } from "./model-search.js";
import { searxngKind } from "./searxng.js";
import { tavilyKind } from "./tavily.js";

/** Every kind of search backend, in the order "Search with" lists them. A
 *  new service is a module here and nothing else. */
export const SEARCH_KINDS: readonly SearchKind[] = [modelSearchKind, tavilyKind, exaKind, searxngKind];
