import type { FeatureStateDto } from "./features.js";
import type { ProjectDto } from "./projects.js";

export interface ProjectStateDto extends ProjectDto {
  tmuxAlive: boolean;
  tmuxStatus?: "alive" | "gone";
  features: FeatureStateDto[];
}
