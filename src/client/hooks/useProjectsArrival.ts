import { useEffect, useState } from "react";
import { useProjectsStore } from "@/store/projects";

/** How long a view waits for the projects before saying they haven't come. */
const PROJECTS_WAIT_MS = 10_000;

/** Whether the projects have arrived: "loading" while they may yet, "late"
 *  once they have been waited for PROJECTS_WAIT_MS. The events stream
 *  reconnects when they can't be read; if they never arrive, a view says so
 *  rather than wait quietly for ever. */
export function useProjectsArrival(): "loaded" | "loading" | "late" {
  const loaded = useProjectsStore((s) => s.loaded);
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (loaded) return;
    const timer = setTimeout(() => setLate(true), PROJECTS_WAIT_MS);
    return () => clearTimeout(timer);
  }, [loaded]);
  return loaded ? "loaded" : late ? "late" : "loading";
}
