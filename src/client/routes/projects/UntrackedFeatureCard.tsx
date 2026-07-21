import { Link } from "react-router";
import type { Feature } from "@/store/projects";
import type { PaneDisplayStatus } from "./feature-card-data";
import { PaneDot } from "@/components/PaneDot";

interface Props {
  projectSlug: string;
  feature: Feature;
  paneStatus: PaneDisplayStatus;
}

export function UntrackedFeatureCard({ projectSlug, feature, paneStatus }: Props) {
  return (
    <Link
      to={`/projects/${encodeURIComponent(projectSlug)}/features/${encodeURIComponent(feature.tmuxWindowName)}`}
      className="block rounded-lg border border-dashed border-border bg-card/60 p-3.5 opacity-75 transition hover:opacity-100"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-sm font-medium">{feature.name}</span>
        <span className="shrink-0 label-micro text-faint">untracked</span>
        <span className="ml-auto flex items-center">
          <PaneDot status={paneStatus} />
        </span>
      </div>
    </Link>
  );
}
