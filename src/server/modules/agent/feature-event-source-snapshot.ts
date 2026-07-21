import type { FeatureEventContent } from "../../../shared/agent-message-types.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { WorkItemStore } from "./work-item-store.js";

interface FeatureEventSourceSnapshotDeps {
  projectsStore?: Pick<ProjectsStore, "getById">;
  featuresStore?: Pick<FeaturesStore, "getById">;
  workStore?: Pick<WorkItemStore, "getByFeature">;
}

export function buildFeatureEventSourceSnapshot(
  deps: FeatureEventSourceSnapshotDeps,
  featureId: string
): NonNullable<FeatureEventContent["source"]> {
  const feature = deps.featuresStore?.getById(featureId) ?? null;
  const workItem = deps.workStore?.getByFeature(featureId) ?? null;
  const projectId = workItem?.projectId ?? feature?.projectId ?? null;
  const project = projectId ? deps.projectsStore?.getById(projectId) ?? null : null;
  return {
    ...(projectId || project?.name
      ? {
          project: {
            ...(projectId ? { id: projectId } : {}),
            ...(trimmedOrUndefined(project?.name) ? { name: trimmedOrUndefined(project?.name) } : {})
          }
        }
      : {}),
    feature: {
      id: featureId,
      ...(trimmedOrUndefined(feature?.name) ? { name: trimmedOrUndefined(feature?.name) } : {})
    },
    ...(workItem
      ? {
          workItem: {
            id: workItem.id,
            ...(trimmedOrUndefined(workItem.title) ? { title: trimmedOrUndefined(workItem.title) } : {})
          }
        }
      : {}),
    capturedAt: new Date().toISOString()
  };
}

function trimmedOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
