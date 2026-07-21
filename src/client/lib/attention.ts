import type { Project } from "@/store/projects";
import type { WorkItemDto } from "@shared/api/work-items";
import { featureHref } from "@/lib/feature-href";

export interface AttentionFeature {
  featureId: string;
  featureName: string;
  projectName: string;
  href: string;
  needsUser: "input" | "review";
}

/** Urgency order. `input` is a person being blocked on; `review` is work
 *  waiting to be looked at. */
const URGENCY_RANK: Record<"input" | "review", number> = { input: 0, review: 1 };

/** Every live feature whose bound work item needs the user, ordered.
 *
 *  Sort key, in full: urgency, then feature name, then project name. It is
 *  deliberately not recency — this list is scanned, and an order that
 *  reshuffles on each activity update is harder to scan than one that holds
 *  still. FeatureDto also carries no activity timestamp, so recency ordering
 *  would need a field that does not exist.
 *
 *  The project-name tiebreak is what makes that promise true rather than
 *  merely intended. A feature name is unique only within its project — the
 *  partial unique index `idx_features_active_name` in the features module
 *  schema is on `(project_id, name)` where `archived_at is null` — so two live
 *  features in different projects may carry the same name, whether or not any
 *  pair happens to today. Two rows that compare equal keep whatever order
 *  `items` happened to arrive in. For the real caller that is work-item Map
 *  insertion order, which is populated newest-activity-first, so without the
 *  tiebreak such rows would reorder themselves on reload: recency ordering
 *  sneaking in through the back door, in exactly the case the paragraph above
 *  says it never happens. With the tiebreak the
 *  order is total, because live project names are unique — see the partial
 *  unique index `idx_projects_active_name` in the projects module schema —
 *  and the store holds only live projects. Two rows can still tie only by
 *  being the same feature, in which case they are indistinguishable anyway.
 *
 *  Membership, not just order, comes from the store: an item whose featureId
 *  is absent from `projects` is skipped, and that absence is what excludes
 *  features of archived projects, since the store is loaded from listActive.
 *  It also covers an item that outlived its feature. Either way there is no
 *  row to route to, so counting it would badge the user toward nothing.
 *
 *  This is the single definition of "needs you" — countAttention below is its
 *  length. Restating the rule in a component is how the Home badge ends up
 *  saying 3 while the band shows 2. Pure, so both can be unit-tested without
 *  React. */
export function selectAttentionFeatures(
  projects: Project[],
  items: Iterable<WorkItemDto>
): AttentionFeature[] {
  const byFeatureId = new Map<string, { project: Project; feature: Project["features"][number] }>();
  for (const project of projects) {
    for (const feature of project.features) byFeatureId.set(feature.id, { project, feature });
  }

  const rows: AttentionFeature[] = [];
  for (const item of items) {
    if (item.needsUser === null) continue;
    const found = byFeatureId.get(item.featureId);
    if (!found) continue;
    rows.push({
      featureId: found.feature.id,
      featureName: found.feature.name,
      projectName: found.project.name,
      href: featureHref(found.project.tmuxSessionName, found.feature.tmuxWindowName),
      needsUser: item.needsUser
    });
  }

  rows.sort((a, b) => {
    const byUrgency = URGENCY_RANK[a.needsUser] - URGENCY_RANK[b.needsUser];
    if (byUrgency !== 0) return byUrgency;
    const byName = a.featureName.localeCompare(b.featureName);
    if (byName !== 0) return byName;
    return a.projectName.localeCompare(b.projectName);
  });
  return rows;
}

/** Live count of work items needing the user, for the nav badges. Defined as
 *  the selection's length and never as a second filter, so the badge and the
 *  band cannot disagree about what counts. */
export function countAttention(projects: Project[], items: Iterable<WorkItemDto>): number {
  return selectAttentionFeatures(projects, items).length;
}
