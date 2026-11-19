import { useEffect, useLayoutEffect } from "react";
import { useSearchParams } from "react-router";
import { useThreadsListStore } from "@/store/threads-list";

/** `?project=<name>` opens Active (Archived with `&tab=archived`) filtered
 *  to that project alone, in place of the filters this browser kept, then
 *  leaves the address: a project's page links its threads so. The filter is
 *  set before the first paint, so the old one never shows; the address is
 *  left after it, once the router listens (a router mounted with the page
 *  starts listening in its own layout effect, after this page's). */
export function useProjectFilterFromAddress(): void {
  const [params, setParams] = useSearchParams();
  const project = params.get("project");
  const tab = params.get("tab") === "archived" ? "archived" : "active";
  useLayoutEffect(() => {
    if (project) useThreadsListStore.setState({ tab, filters: { labels: [], projects: [project] } });
  }, [project, tab]);
  useEffect(() => {
    if (project === null) return;
    const next = new URLSearchParams(params);
    next.delete("project");
    next.delete("tab");
    setParams(next, { replace: true });
    // The param is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);
}
