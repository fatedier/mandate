import { Activity, BarChart2, Bell, FileText, MessagesSquare } from "lucide-react";
import type { AgentMessage } from "@/store/agent-chat";
import {
  featureEventProvenanceDetail,
  featureEventTitle,
  firstFeatureEventFromWakeMetadata
} from "@/lib/feature-event-source";
import type { AgentWakeMetadata, AgentWakeReason } from "@shared/api-contracts";

type ProvenanceIcon = typeof Activity;

export interface ChatProvenance {
  label: string;
  source: string;
  detail: string;
  title?: string;
  createdAt?: string;
  icon: ProvenanceIcon;
}

function shouldShowWakeProvenance(
  reason: AgentWakeReason | null | undefined
): reason is AgentWakeReason {
  return Boolean(reason && reason !== "user" && reason !== "watch");
}

export function provenanceForWake(
  reason: AgentWakeReason | null | undefined,
  opts: { wakeId?: string | null; createdAt?: string; metadata?: AgentWakeMetadata | null } = {}
): ChatProvenance | null {
  if (!shouldShowWakeProvenance(reason)) return null;
  const baseTitle = [`wake reason: ${reason}`, opts.wakeId ? `wake id: ${opts.wakeId}` : null]
    .filter(Boolean)
    .join("\n");

  switch (reason) {
    case "side-summary":
      return {
        label: "SIDE",
        source: "side conversation",
        detail: "user-approved summary",
        title: baseTitle,
        createdAt: opts.createdAt,
        icon: MessagesSquare
      };
    case "work-item-heartbeat":
      return {
        label: "HEARTBEAT",
        source: "work-item",
        detail: "auto · 30m · checked active items",
        title: baseTitle,
        createdAt: opts.createdAt,
        icon: Activity
      };
    case "alarm":
      return {
        label: "ALARM",
        source: "scheduled",
        detail: "fired · scheduled wake",
        title: baseTitle,
        createdAt: opts.createdAt,
        icon: Bell
      };
    case "feature-event": {
      const featureEvent = firstFeatureEventFromWakeMetadata(opts.metadata);
      return {
        label: "FEATURE",
        source: "task",
        detail: featureEvent ? featureEventProvenanceDetail(featureEvent) : "event · feature task update",
        title: featureEvent ? featureEventTitle(featureEvent, baseTitle) : baseTitle,
        createdAt: opts.createdAt,
        icon: Activity
      };
    }
    case "analyzer-event":
      return {
        label: "ANALYZER",
        source: "pane",
        detail: "update · analysis event",
        title: baseTitle,
        createdAt: opts.createdAt,
        icon: BarChart2
      };
    case "work-item-promote":
      return {
        label: "WORK ITEM",
        source: "promoted",
        detail: "user action · promoted into chat",
        title: baseTitle,
        createdAt: opts.createdAt,
        icon: Activity
      };
  }
  return null;
}

export function provenanceForSystemMessage(message: AgentMessage): ChatProvenance | null {
  const text = message.content.type === "text" ? message.content.text : "";
  const title = [
    `message source: ${message.source}`,
    message.wakeId ? `wake id: ${message.wakeId}` : null,
    message.wakeReason ? `wake reason: ${message.wakeReason}` : null,
    text ? `content:\n${text}` : null
  ]
    .filter(Boolean)
    .join("\n");

  if (message.source === "runtime-context") {
    const kind = runtimeContextKind(message);
    return {
      label: "CONTEXT",
      source: "runtime_context",
      detail: kind === "initial" ? "initial snapshot" : "snapshot",
      title,
      createdAt: message.createdAt,
      icon: FileText
    };
  }
  if (message.source === "restart-recovery") {
    return {
      label: "RECOVERY",
      source: "server restart",
      detail: "checking progress and continuing",
      title,
      createdAt: message.createdAt,
      icon: Activity
    };
  }
  if (message.source === "watch") {
    return {
      label: "WATCH",
      source: "pane",
      detail: watchDetail(text),
      title,
      createdAt: message.createdAt,
      icon: Bell
    };
  }
  if (message.source === "alarm" || message.source === "scheduled") {
    return {
      label: "ALARM",
      source: "scheduled",
      detail: text ? `fired · ${alarmDetail(text)}` : "fired",
      title,
      createdAt: message.createdAt,
      icon: Bell
    };
  }
  if (message.source === "analyzer-event") {
    return {
      label: "ANALYZER",
      source: "pane",
      detail: "update",
      title,
      createdAt: message.createdAt,
      icon: BarChart2
    };
  }
  if (message.source === "compression") {
    return {
      label: "CONTEXT",
      source: "compression",
      detail:
        message.content.type === "summary"
          ? `compressed ${message.content.replacedCount} earlier messages`
          : "compressed",
      title,
      createdAt: message.createdAt,
      icon: FileText
    };
  }
  return null;
}

function runtimeContextKind(message: AgentMessage): "initial" | "update" | null {
  if (message.content.type !== "text") return null;
  const kind = message.content.metadata?.runtimeContextKind;
  if (kind === "initial" || kind === "update") return kind;
  return null;
}

function watchDetail(text: string): string {
  const result = lineValue(text, "result");
  const paneId = lineValue(text, "paneId");
  const note = lineValue(text, "note");
  const stableMs = Number(lineValue(text, "stableMs"));
  const stable = Number.isFinite(stableMs) && stableMs > 0
    ? ` for ${formatStableWindow(stableMs)}`
    : "";
  const status = result === "timeout"
    ? "timed out"
    : result === "target_missing"
      ? "no longer exists"
      : "stable";
  const target = paneId ? `pane ${paneId} ` : "pane ";
  const base = `${target}${status}${status === "stable" ? stable : ""}`;
  return note ? `${base} · ${inlineDetail(note)}` : base;
}

function alarmDetail(text: string): string {
  const note = text.match(/^note:\s*(.+)$/im)?.[1]?.trim();
  return note ? `note: ${inlineDetail(note)}` : inlineDetail(text);
}

function lineValue(text: string, key: string): string | null {
  return text.match(new RegExp(`^${key}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? null;
}

/** The configured stability window a watch_window event was waiting on — a
 *  setting, not a measurement, which is why whole minutes and whole seconds
 *  are the normal case and get rendered as such. */
function formatStableWindow(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function inlineDetail(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
