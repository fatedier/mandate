import type { WorkerDto } from "./workers.js";
import type { ProjectDto } from "./projects.js";

export interface ProjectStateDto extends ProjectDto {
  /** Whether the project's tmux session is there. */
  tmuxStatus: "alive" | "gone";
  workers: WorkerDto[];
}
