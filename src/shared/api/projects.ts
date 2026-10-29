import type { ApiErrorResponse } from "./common.js";

export type ProjectOwnership = "app" | "adopted";

export interface ProjectDto {
  id: string;
  name: string;
  workingDir: string;
  isGit: boolean;
  gitRemote: string | null;
  tmuxSessionName: string;
  ownership: ProjectOwnership;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProjectsListResponse {
  projects: ProjectDto[];
}

export type CreateProjectRequest = Pick<ProjectDto, "name" | "workingDir">;

export type CreateProjectResponse = ProjectDto | ApiErrorResponse;

export interface ReorderProjectsRequest {
  projectIds: string[];
}

export interface ReorderProjectsResponse {
  projects: ProjectDto[];
}

export interface AdoptProjectRequest {
  sessionName: string;
  projectName: string;
  workingDir: string;
}

export type AdoptProjectResponse = ProjectDto | ApiErrorResponse;

/** A project's working directory, changed in place: its id, and so its
 *  memories and threads, stay. */
export interface ChangeProjectWorkingDirRequest {
  workingDir: string;
}

/** Refused: the workers whose worktrees belong to another repository than
 *  the new directory, to be archived first. */
export interface ChangeProjectWorkingDirRefusal extends ApiErrorResponse {
  workers?: Array<{ id: string; name: string }>;
}

export type ChangeProjectWorkingDirResponse = ProjectDto | ChangeProjectWorkingDirRefusal;

