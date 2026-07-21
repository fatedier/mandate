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

export type GitBranchesResponse = {
  branches: string[];
  currentBranch: string | null;
  defaultBaseRef: string | null;
} | ApiErrorResponse;
