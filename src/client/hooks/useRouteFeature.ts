import { useMatch } from "react-router";
import { useShallow } from "zustand/react/shallow";
import { findFeatureBySlug, useProjectsStore } from "@/store/projects";

/** The feature identified by the current route, if any. Single source for
 *  "which feature scope should chat affordances target here". */
export function useRouteFeature(): { id: string; name: string } | null {
  const featureMatch = useMatch("/projects/:projectSlug/features/:featureSlug/*");
  return useProjectsStore(
    useShallow((s) => {
      if (!featureMatch) return null;
      const project = s.bySlug[featureMatch.params.projectSlug ?? ""];
      const feature = findFeatureBySlug(project, featureMatch.params.featureSlug);
      if (!feature) return null;
      return { id: feature.id, name: feature.name };
    })
  );
}
