import { create } from "zustand";
import { PAGE_QUOTES_MAX, type PageQuote } from "@shared/page-quotes";

const NONE: readonly PageQuote[] = [];

interface PageQuotesStore {
  /** The page's items quoted in a composer and not sent yet, by the
   *  composer's draft key. */
  byKey: ReadonlyMap<string, readonly PageQuote[]>;
  /** Adds one to the composer: false when it holds as many as a message may
   *  quote. The same item quoted again stays one. */
  add(key: string, quote: PageQuote): boolean;
  remove(key: string, quote: PageQuote): void;
  /** The quotes that were sent go; any added meanwhile stay. */
  sent(key: string, quotes: readonly PageQuote[]): void;
}

const same = (a: PageQuote, b: PageQuote) => a.path === b.path && a.text === b.text;

/** Quotes are part of a composer's draft, kept here rather than in the
 *  composer (composer-hooks keeps its words): the page's pane adds them, and
 *  on a phone the composer is not drawn while the page is. */
export const usePageQuotes = create<PageQuotesStore>((set, get) => {
  const put = (key: string, quotes: readonly PageQuote[]) => set((state) => {
    const byKey = new Map(state.byKey);
    if (quotes.length > 0) byKey.set(key, quotes);
    else byKey.delete(key);
    return { byKey };
  });
  return {
    byKey: new Map(),
    add: (key, quote) => {
      const quotes = get().byKey.get(key) ?? NONE;
      if (quotes.some((q) => same(q, quote))) return true;
      if (quotes.length >= PAGE_QUOTES_MAX) return false;
      put(key, [...quotes, quote]);
      return true;
    },
    remove: (key, quote) => put(key, (get().byKey.get(key) ?? NONE).filter((q) => !same(q, quote))),
    sent: (key, quotes) => put(key, (get().byKey.get(key) ?? NONE).filter((q) => !quotes.some((s) => same(s, q))))
  };
});

/** A composer's quotes, none when it has none. */
export function usePageQuotesOf(key: string | null): readonly PageQuote[] {
  return usePageQuotes((state) => (key ? state.byKey.get(key) : undefined) ?? NONE);
}
