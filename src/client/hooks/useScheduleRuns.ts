import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api-base";
import { readJson } from "@/lib/api-json";
import { API_PATHS } from "@shared/api-contracts";
import type { ScheduleDto, ScheduleRunDto, ScheduleRunsResponse } from "@shared/api/schedules";

/** Each schedule's checks, read once they show (the newest ten), and read
 *  again when a check of it has run since (its last run moved). */
export function useScheduleRuns(schedules: Pick<ScheduleDto, "id" | "lastRunAt">[]): Map<string, ScheduleRunDto[]> {
  const [runs, setRuns] = useState<Map<string, ScheduleRunDto[]>>(new Map());
  const keys = schedules.map((s) => `${s.id}@${s.lastRunAt ?? ""}`).join(",");
  useEffect(() => {
    const abort = new AbortController();
    for (const id of keys.split(",").filter(Boolean).map((key) => key.slice(0, key.lastIndexOf("@")))) {
      void fetch(apiPath(API_PATHS.scheduleRuns(id)), { signal: abort.signal })
        .then((res) => readJson<ScheduleRunsResponse>(res))
        // A read that fails shows no checks: the rest says the state.
        .then((body) => { if (!abort.signal.aborted) setRuns((prev) => new Map(prev).set(id, body.runs)); }, () => {});
    }
    return () => abort.abort();
  }, [keys]);
  return runs;
}
