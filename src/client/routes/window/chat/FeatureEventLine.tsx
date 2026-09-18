import { memo } from "react";
import { AlertTriangle, HelpCircle, Activity } from "lucide-react";
import type { FeatureEventContent } from "@shared/agent-message-types";
import { formatClockTime, formatDateTimeTitle } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CanvasReferenceCard } from "./CanvasReferenceCard";
import { featureEventStatus, formatFeatureEventSourceLabel } from "@/lib/feature-event-source";

interface FeatureEventLineProps {
  content: FeatureEventContent;
  createdAt?: string;
}

/**
 * Compact system-event line for `feature_event` messages — matches the visual
 * language of SystemMessage (watch / analyzer-event / compression) but uses
 * kind-specific icon + color since we have structured payload.
 */
function FeatureEventLineImpl({ content, createdAt }: FeatureEventLineProps) {
  const variant = resolveVariant(content);
  const sourceLabel = formatFeatureEventSourceLabel(content.source);
  const time = createdAt ? formatClockTime(createdAt) : null;
  const canvasArtifacts = (content.artifacts ?? []).filter(
    (artifact) => artifact.type === "canvas"
  );

  return (
    <div className="my-1 flex flex-col gap-1">
      <div
        className={cn(
          "flex h-6 items-center gap-2 px-1 text-2xs",
          variant.containerCls
        )}
      >
        <variant.Icon className={cn("size-3.5 shrink-0", variant.iconCls)} aria-hidden="true" />
        <span className="shrink-0 label-micro">feature</span>
        <span className="min-w-0 truncate">
          {sourceLabel ? <span className="text-faint">{sourceLabel} · </span> : null}
          <span className="font-medium">{content.label}</span>
          <span> · {variant.verb}</span>
          {content.summary ? (
            <>
              <span>: </span>
              <span>{content.summary}</span>
            </>
          ) : null}
        </span>
        {time ? (
          <time
            className="ml-auto shrink-0 text-2xs tabular-nums text-faint"
            dateTime={createdAt}
            title={createdAt ? formatDateTimeTitle(createdAt) : undefined}
          >
            {time}
          </time>
        ) : null}
      </div>
      {canvasArtifacts.length > 0 ? (
        <div className="pl-6">
          {canvasArtifacts.map((artifact) => (
            <CanvasReferenceCard
              key={artifact.canvasId}
              title={artifact.title}
              path={artifact.path}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface Variant {
  Icon: typeof AlertTriangle;
  iconCls: string;
  containerCls: string;
  verb: string;
}

function resolveVariant(content: FeatureEventContent): Variant {
  if (content.kind === "limit_reached") {
    return {
      Icon: Activity,
      iconCls: "text-faint",
      containerCls: "text-faint",
      verb: `hit step limit (${content.stepCount})`
    };
  }
  if (content.kind === "completion") {
    return {
      Icon: Activity,
      iconCls: "text-faint",
      containerCls: "text-faint",
      verb: "completed"
    };
  }
  if (content.signal === "blocked") {
    return {
      Icon: AlertTriangle,
      iconCls: "text-faint",
      containerCls: "text-faint",
      verb: "blocked"
    };
  }
  if (content.signal === "needs_user") {
    return {
      Icon: HelpCircle,
      iconCls: "text-faint",
      containerCls: "text-faint",
      verb: "needs user"
    };
  }
  return {
    Icon: Activity,
    iconCls: "text-faint",
    containerCls: "text-faint",
    verb: featureEventStatus(content)
  };
}

// Memoised: the transcript re-renders on every streaming delta, and an
// unmemoised row means all of them re-render for each token.
export const FeatureEventLine = memo(FeatureEventLineImpl);
