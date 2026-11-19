import { useEffect, useState } from "react";
import type { ActivityFilterOptionsResponse } from "@shared/api-contracts";
import { readJson } from "@/lib/api-json";
import { api } from "@/lib/api-paths";

/** Every model and purpose the log has, read once each time the log opens;
 *  null until it answers, and if it fails (the loaded rows stand in). */
export function useActivityFilterOptions(): ActivityFilterOptionsResponse | null {
  const [options, setOptions] = useState<ActivityFilterOptionsResponse | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(api.activityFilterOptions, { signal: controller.signal })
      .then((res) => readJson<ActivityFilterOptionsResponse>(res))
      .then((payload) => { if (!controller.signal.aborted) setOptions(payload); })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return options;
}
