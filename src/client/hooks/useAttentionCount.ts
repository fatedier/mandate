import { useMemo } from "react";
import { useProjectsStore } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import { countAttention } from "@/lib/attention";

/** Live count of work items needing the user, for the Home nav badge.
 *  Recomputes when either store publishes a new reference. */
export function useAttentionCount(): number {
  const projects = useProjectsStore((s) => s.projects);
  const items = useWorkItemsStore((s) => s.items);
  return useMemo(() => countAttention(projects, items.values()), [projects, items]);
}
