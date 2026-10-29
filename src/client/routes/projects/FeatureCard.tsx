import { paneStatusForFeature } from "./feature-card-data";
import { useSnapshotStore } from "@/store/snapshot";
import { FeatureRow, type FeatureRowProps } from "./FeatureRow";

type FeatureCardProps = Omit<FeatureRowProps, "paneStatus">;

/** Thin data wrapper: resolves the pane status from the snapshot store and
 *  renders the row. Everything visual lives in `FeatureRow`. */
export function FeatureCard(props: FeatureCardProps) {
  const paneStatus = useSnapshotStore((s) => (
    paneStatusForFeature(props.projectSlug, props.feature.tmuxWindowName, s.snapshot)
  ));
  return <FeatureRow {...props} paneStatus={paneStatus} />;
}
