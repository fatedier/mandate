import type { Feature } from "@/store/projects";
import type { WorkItemDto } from "@shared/api/work-items";
import { paneStatusForFeature } from "./feature-card-data";
import { useSnapshotStore } from "@/store/snapshot";
import { TopFeatureCard } from "./TopFeatureCard";
import { PassiveFeatureCard } from "./PassiveFeatureCard";
import { UntrackedFeatureCard } from "./UntrackedFeatureCard";

interface FeatureCardProps {
  variant: "top" | "passive" | "untracked";
  projectSlug: string;
  feature: Feature;
  item: WorkItemDto | null;
  onTogglePin?: () => void;
  onAck?: () => void;
  onPromote?: () => void;
}

const noop = () => {};

export function FeatureCard(props: FeatureCardProps) {
  const paneStatus = useSnapshotStore((s) => (
    paneStatusForFeature(props.projectSlug, props.feature.tmuxWindowName, s.snapshot)
  ));
  if (props.variant === "untracked" || !props.item) {
    return (
      <UntrackedFeatureCard
        projectSlug={props.projectSlug}
        feature={props.feature}
        paneStatus={paneStatus}
      />
    );
  }
  if (props.variant === "top") {
    return (
      <TopFeatureCard
        projectSlug={props.projectSlug}
        feature={props.feature}
        item={props.item}
        paneStatus={paneStatus}
        onTogglePin={props.onTogglePin ?? noop}
        onAck={props.onAck ?? noop}
        onPromote={props.onPromote ?? noop}
      />
    );
  }
  return (
    <PassiveFeatureCard
      projectSlug={props.projectSlug}
      feature={props.feature}
      item={props.item}
      paneStatus={paneStatus}
      onTogglePin={props.onTogglePin ?? noop}
      onPromote={props.onPromote}
    />
  );
}
