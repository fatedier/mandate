import { paneStatusForWorker } from "./worker-card-data";
import { useSnapshotStore } from "@/store/snapshot";
import { WorkerRow, type WorkerRowProps } from "./WorkerRow";

type ProjectWorkerCardProps = Omit<WorkerRowProps, "paneStatus">;

/** Thin data wrapper: resolves the pane status from the snapshot store and
 *  renders the row. Everything visual lives in `WorkerRow`. */
export function ProjectWorkerCard(props: ProjectWorkerCardProps) {
  const paneStatus = useSnapshotStore((s) => (
    paneStatusForWorker(props.projectSlug, props.worker.tmuxWindowName, s.snapshot)
  ));
  return <WorkerRow {...props} paneStatus={paneStatus} />;
}
