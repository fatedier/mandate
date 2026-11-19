import { useCallback, useEffect, useRef, useState } from "react";
import type { LearnedSkillDetailResponse, LearnedSkillRevisionResponse, LearnedSkillsResponse } from "@shared/api-contracts";
import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";
import { errorText } from "@shared/error-text";

/** One read of a page's data: the newest answer only, aborted when the
 *  address changes or the view goes. Null address: nothing to read. */
function useRead<T>(url: string | null, version = 0): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  // With the address it answers: a newer address shows nothing of the old one's.
  const [answer, setAnswer] = useState<{ url: string; data: T } | null>(null);
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!url) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const payload = await readJson<T>(await fetch(url, { signal }));
      if (mine !== seq.current) return;
      setAnswer({ url, data: payload });
      setFailure(null);
    } catch (err) {
      if ((err as Error)?.name === "AbortError" || mine !== seq.current) return;
      setFailure({ url, message: errorText(err) });
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [url]);
  // Deferred by a zero timer, as the rest of the Memory page: loading state
  // is not set during the commit.
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `version`: a read asked for again (Refresh) at the same address.
  }, [load, version]);
  return {
    data: answer && answer.url === url ? answer.data : null,
    error: failure && failure.url === url ? failure.message : null,
    loading,
    reload: () => void load()
  };
}

export interface SkillListFilters {
  /** "all", "global", or "project:<id>". */
  scope: string;
  status: "available" | "archived";
}

export function useLearnedSkills(filters: SkillListFilters, version = 0) {
  const params = new URLSearchParams();
  if (filters.scope === "global") params.set("scope", "global");
  else if (filters.scope.startsWith("project:")) {
    params.set("scope", "project");
    params.set("projectId", filters.scope.slice("project:".length));
  }
  params.set("status", filters.status);
  return useRead<LearnedSkillsResponse>(api.learnedSkills(params), version);
}

export function useLearnedSkill(id: string, version = 0) {
  return useRead<LearnedSkillDetailResponse>(api.learnedSkill(id), version);
}

export function useSkillRevision(id: string, revision: number | null, version = 0) {
  return useRead<LearnedSkillRevisionResponse>(revision === null ? null : api.learnedSkillRevision(id, revision), version);
}
