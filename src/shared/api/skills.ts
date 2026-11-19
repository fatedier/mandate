export type SkillSource = "builtin" | "user" | "extra";
type SkillScopeDto = "manager" | "worker" | "personal";

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

/** Who wrote a learned skill's revision, and in which conversation. */
export interface LearnedSkillAuthorDto {
  by: "agent" | "review" | "tidy" | "rule";
  threadId: string | null;
  /** The conversation as the owner knows it: a thread's title, a worker's name. */
  threadTitle: string | null;
  threadKind: "manager" | "worker" | "personal" | "other" | null;
}

/** A learned skill in a list: everything but its text. */
export interface LearnedSkillSummaryDto {
  id: string;
  name: string;
  description: string;
  scope: "user" | "project";
  projectId: string | null;
  projectName: string | null;
  status: "available" | "archived";
  archivedReason: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  uses30: number;
  uses90: number;
  createdBy: LearnedSkillAuthorDto;
  lastChange: LearnedSkillAuthorDto & { at: string; reason: string | null; change: LearnedSkillChangeDto };
}

export type LearnedSkillChangeDto = "create" | "patch" | "rewrite" | "revert" | "archive" | "restore" | "merge" | "move";

export interface LearnedSkillDto extends LearnedSkillSummaryDto {
  body: string;
}

/** One revision in a skill's history, without its text. */
export interface LearnedSkillVersionDto extends LearnedSkillAuthorDto {
  revision: number;
  change: LearnedSkillChangeDto;
  reason: string | null;
  at: string;
  name: string;
  description: string;
  status: "available" | "archived";
  scope: "user" | "project";
  projectId: string | null;
  projectName: string | null;
  runId: string | null;
}

export interface LearnedSkillsResponse {
  skills: LearnedSkillSummaryDto[];
  /** The projects a skill can belong to: the active ones and any a skill names. */
  projects: Array<{ id: string; name: string }>;
}

export interface LearnedSkillDetailResponse {
  skill: LearnedSkillDto;
  versions: LearnedSkillVersionDto[];
}

export interface LearnedSkillRevisionResponse {
  version: LearnedSkillVersionDto;
  body: string;
  /** The revision it is compared with: the one before that is still kept; null for the first. */
  against: number | null;
  /** Unified hunks against `against` (against nothing for the first); null when too large to work out. */
  patch: string | null;
}

export interface SkillReviewRunDto {
  id: string;
  threadId: string;
  threadTitle: string | null;
  threadKind: LearnedSkillAuthorDto["threadKind"];
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  outcome: "none" | "created" | "changed" | "restored" | null;
  skillId: string | null;
  skillName: string | null;
  revision: number | null;
  reason: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A tidy of all learned skills, and the revisions it wrote. */
export interface SkillTidyRunDto {
  id: string;
  status: "running" | "succeeded" | "failed";
  reason: string | null;
  error: string | null;
  changed: Array<{ skillId: string; skillName: string | null; revision: number }>;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface SkillReviewRunsResponse {
  runs: SkillReviewRunDto[];
  tidies: SkillTidyRunDto[];
}
