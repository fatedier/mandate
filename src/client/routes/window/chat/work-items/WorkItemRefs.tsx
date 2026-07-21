import { useMemo } from "react";
import { useProjectsStore } from "@/store/projects";

interface ResolvedFeatureRef {
  featureId: string;
  featureName: string;
  featureSlug: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
}

interface ResolvedProjectRef {
  projectId: string;
  projectName: string;
  projectSlug: string;
}

function useResolvedRefs(featureRefs: string[] | undefined, projectRefs: string[] | undefined) {
  // Select the stable projects array; resolve in a memo so we don't return a
  // new object from the zustand selector on every render (which would cause an
  // infinite re-render via useSyncExternalStore).
  const projectsState = useProjectsStore((s) => s.projects);
  return useMemo(() => {
    const fRefs = featureRefs ?? [];
    const pRefs = projectRefs ?? [];
    const features: ResolvedFeatureRef[] = [];
    const projects: ResolvedProjectRef[] = [];
    const featureProjectIds = new Set<string>();
    for (const fid of fRefs) {
      for (const p of projectsState) {
        const f = p.features.find((ff) => ff.id === fid);
        if (f) {
          features.push({
            featureId: fid,
            featureName: f.name,
            featureSlug: f.tmuxWindowName,
            projectId: p.id,
            projectName: p.name,
            projectSlug: p.tmuxSessionName
          });
          featureProjectIds.add(p.id);
          break;
        }
      }
    }
    for (const pid of pRefs) {
      if (featureProjectIds.has(pid)) continue;
      const p = projectsState.find((pp) => pp.id === pid);
      if (p) {
        projects.push({
          projectId: pid,
          projectName: p.name,
          projectSlug: p.tmuxSessionName
        });
      }
    }
    return { features, projects };
  }, [projectsState, featureRefs, projectRefs]);
}

/** Compact inline chip set — shows up to `max` refs followed by "+N" overflow.
 *  Used on a list row alongside the title. */
export function WorkItemRefsInline({
  featureRefs,
  projectRefs,
  max = 2
}: {
  featureRefs: string[];
  projectRefs: string[];
  max?: number;
}) {
  const { features, projects } = useResolvedRefs(featureRefs, projectRefs);
  const total = features.length + projects.length;
  if (total === 0) return null;

  const slots: React.ReactNode[] = [];
  for (const f of features) {
    if (slots.length >= max) break;
    slots.push(
      <span
        key={`f-${f.featureId}`}
        className="inline-flex items-center gap-1 text-2xs text-muted-foreground"
      >
        <span className="text-muted-foreground/60">{f.projectName}</span>
        <span className="text-muted-foreground/40">·</span>
        <span>{f.featureName}</span>
      </span>
    );
  }
  for (const p of projects) {
    if (slots.length >= max) break;
    slots.push(
      <span
        key={`p-${p.projectId}`}
        className="inline-flex items-center text-2xs text-muted-foreground"
      >
        {p.projectName}
      </span>
    );
  }
  const remaining = total - slots.length;

  return (
    <span className="inline-flex items-center gap-2">
      {slots.map((s, i) => (
        <span key={i} className="inline-flex items-center">
          {s}
        </span>
      ))}
      {remaining > 0 ? (
        <span className="text-2xs text-muted-foreground/60">+{remaining}</span>
      ) : null}
    </span>
  );
}
