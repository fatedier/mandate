import { useEffect, useState } from "react";
import { pinyinMatcher, type PinyinMatch } from "@shared/title-match";

let loaded: PinyinMatch | null = null;
let loading: Promise<PinyinMatch> | null = null;

/** pinyin-pro's match, loaded the first time it is wanted (an @ typed): the
 *  page does not carry its dictionary (~80 KB) before. Null until it is here;
 *  a load that failed is tried again the next time it is wanted. */
export function usePinyinMatch(wanted: boolean): PinyinMatch | null {
  const [, setLoads] = useState(0);
  useEffect(() => {
    if (!wanted || loaded) return;
    let alive = true;
    loading ??= import("pinyin-pro").then((lib) => {
      const match = pinyinMatcher(lib.match);
      loaded = match;
      return match;
    });
    loading.then(
      () => { if (alive) setLoads((n) => n + 1); },
      () => { loading = null; }
    );
    return () => { alive = false; };
  }, [wanted]);
  return loaded;
}
