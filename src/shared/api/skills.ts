export type SkillSource = "builtin" | "user" | "extra";
type SkillScopeDto = "manager" | "worker";

export interface SkillSummaryDto {
  name: string;
  description: string;
  scope: SkillScopeDto[];
  source: SkillSource;
  sourcePath: string;
}

export interface SkillsResponse {
  skills: SkillSummaryDto[];
}
