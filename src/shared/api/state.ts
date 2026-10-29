import type { ProjectStateDto } from "./project-state.js";

export type AppStateErrorDto = string | {
  message: string;
  at?: string;
} | null;

export interface AppStateResponse {
  snapshot: unknown | null;
  error: AppStateErrorDto;
  projects: ProjectStateDto[];
}

export interface AppInfoResponse {
  server: {
    port: number;
    pollIntervalMs: number;
    captureLines: number;
  };
  voice: {
    provider: string;
    model: string;
    voice: string;
    language: string;
    idleTimeoutMs: number;
    maxSessionMs: number;
    configured: boolean;
    baseURL: string;
    deployment: string;
  };
}
