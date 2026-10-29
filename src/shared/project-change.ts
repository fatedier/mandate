import type { AgentMessageContent } from "./agent-message-types.js";

/** What a `project-change` row says changed: a project's working directory. */
export interface ProjectChange {
  projectId: string;
  projectName: string;
  from: string;
  to: string;
}

const METADATA_KEY = "projectChange";

export function projectChangeMetadata(change: ProjectChange): Record<string, unknown> {
  return { [METADATA_KEY]: { ...change } };
}

export function projectChangeOf(content: AgentMessageContent): ProjectChange | null {
  if (content.type !== "text") return null;
  const raw = content.metadata?.[METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { projectId, projectName, from, to } = raw as Record<string, unknown>;
  return typeof projectId === "string" && typeof projectName === "string" && typeof from === "string" && typeof to === "string"
    ? { projectId, projectName, from, to }
    : null;
}
