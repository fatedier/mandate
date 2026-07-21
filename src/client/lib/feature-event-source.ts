import type {
  FeatureEventArtifact,
  FeatureEventContent,
  FeatureEventSourceSnapshot
} from "@shared/agent-message-types";
import type { AgentWakeMetadata } from "@shared/api-contracts";

export interface FeatureEventDisplay {
  type: "feature_event";
  kind: FeatureEventContent["kind"];
  featureId: string;
  workItemId: string | null;
  source?: FeatureEventSourceSnapshot;
  label: string;
  signal?: "blocked" | "needs_user";
  summary?: string;
  taskId?: string;
  stepCount?: number;
  artifacts?: FeatureEventArtifact[];
}

export function formatFeatureEventSourceLabel(
  source: FeatureEventSourceSnapshot | null | undefined
): string | null {
  if (!source) return null;
  const project = displayName(source.project?.name, source.project?.id);
  const feature = displayName(source.feature.name, source.feature.id);
  const parts = [project, feature].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" / ") : null;
}

export function featureEventStatus(content: FeatureEventDisplay): string {
  if (content.kind === "completion") return "completed";
  if (content.kind === "limit_reached") return "limit reached";
  if (content.signal === "blocked") return "blocked";
  if (content.signal === "needs_user") return "needs user";
  return "escalated";
}

export function featureEventProvenanceDetail(content: FeatureEventDisplay): string {
  const sourceLabel = formatFeatureEventSourceLabel(content.source);
  if (!sourceLabel) return "event · feature task update";
  return `${sourceLabel} · ${featureEventStatus(content)}`;
}

export function featureEventTitle(content: FeatureEventDisplay, baseTitle?: string): string {
  const sourceLabel = formatFeatureEventSourceLabel(content.source);
  const lines = [
    baseTitle,
    `task: ${content.label}`,
    `status: ${featureEventStatus(content)}`,
    sourceLabel ? `source: ${sourceLabel}` : null,
    content.source?.workItem?.title ? `work item: ${content.source.workItem.title}` : null,
    content.summary ? `summary: ${content.summary}` : null,
    content.taskId ? `task id: ${content.taskId}` : null,
    `feature id: ${content.featureId}`,
    content.workItemId ? `work item id: ${content.workItemId}` : null,
    content.source?.capturedAt ? `source captured: ${content.source.capturedAt}` : null
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

export function firstFeatureEventFromWakeMetadata(
  metadata: AgentWakeMetadata | null | undefined
): FeatureEventContent | null {
  return metadata?.featureEvents?.[0] ?? null;
}

export function firstFeatureEventFromCallMetadata(
  metadata: Record<string, unknown> | null | undefined
): FeatureEventDisplay | null {
  if (!metadata) return null;
  const direct = firstFeatureEventFromUnknownArray(metadata.featureEvents);
  if (direct) return direct;
  const wakeMetadata = metadata.wakeMetadata;
  if (!wakeMetadata || typeof wakeMetadata !== "object" || Array.isArray(wakeMetadata)) return null;
  return firstFeatureEventFromUnknownArray(
    (wakeMetadata as { featureEvents?: unknown }).featureEvents
  );
}

function firstFeatureEventFromUnknownArray(value: unknown): FeatureEventDisplay | null {
  if (!Array.isArray(value)) return null;
  return value.find(isFeatureEventDisplay) ?? null;
}

function isFeatureEventDisplay(value: unknown): value is FeatureEventDisplay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<FeatureEventDisplay>;
  if (
    event.type !== "feature_event" ||
    typeof event.featureId !== "string" ||
    typeof event.label !== "string"
  ) {
    return false;
  }
  if (event.kind === "limit_reached") return typeof event.stepCount === "number";
  return (event.kind === "completion" || event.kind === "escalation") &&
    typeof event.taskId === "string";
}

function displayName(name: string | null | undefined, id: string | null | undefined): string | null {
  const trimmedName = name?.trim();
  if (trimmedName) return trimmedName;
  const trimmedId = id?.trim();
  return trimmedId || null;
}
