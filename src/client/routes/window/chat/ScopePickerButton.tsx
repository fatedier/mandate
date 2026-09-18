import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { useProjectsStore } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import { useAgentChatStore, scopeKey, type AgentChatScope } from "@/store/agent-chat";
import type { WorkItemDto } from "@shared/api/work-items";
import { cn } from "@/lib/utils";
import { useMemo } from "react";
import { UnreadBadge } from "@/components/UnreadBadge";

const DOT: Record<"input" | "review" | "idle", string> = {
  input: "bg-status-input",
  review: "bg-status-review",
  idle: "bg-faint"
};

/**
 * Mobile scope control for the case `ScopeSwitchButton` cannot serve: a route
 * with no feature of its own, so there is no counterpart to swap to.
 *
 * `ScopeSwitchButton` stays the control wherever a counterpart exists — its
 * own comment is right that a dropdown costs a second tap and a menu layer to
 * solve what one tap already solves. That argument holds only while there is
 * exactly one destination. On `/projects` there is none: `routeFeature` is
 * null, `drawerScope` resets to overview on load, so the switch rendered
 * nothing at all and a phone could not reach a feature's own thread without
 * first navigating to that feature.
 *
 * One rule covers both: the control says where you are, and tapping it takes
 * you elsewhere — straight there when there is one elsewhere, into a list when
 * there are many.
 */
export function ScopePickerButton({
  currentLabel,
  currentScope,
  onPick
}: {
  currentLabel: string;
  currentScope: AgentChatScope;
  onPick: (scope: AgentChatScope) => void;
}) {
  const projects = useProjectsStore((s) => s.projects);
  const items = useWorkItemsStore((s) => s.items);
  const threadsByScope = useAgentChatStore((s) => s.threadsByScope);

  // One map for every row, off a stable store reference — building it in the
  // selector would return a fresh Map per call and re-render on every publish.
  const urgencyByFeatureId = useMemo(() => {
    const map = new Map<string, "input" | "review" | "idle">();
    for (const item of items.values() as Iterable<WorkItemDto>) {
      map.set(item.featureId, item.needsUser ?? "idle");
    }
    return map;
  }, [items]);

  const rows = useMemo(
    () =>
      projects.flatMap((project) =>
        project.features.map((feature) => ({
          id: feature.id,
          name: feature.name,
          project: project.name,
          urgency: urgencyByFeatureId.get(feature.id) ?? "idle"
        }))
      ),
    [projects, urgencyByFeatureId]
  );

  const unreadFor = (scope: AgentChatScope) =>
    threadsByScope.get(scopeKey(scope))?.unreadAssistantCount ?? 0;

  const isCurrent = (scope: AgentChatScope) => scopeKey(scope) === scopeKey(currentScope);

  // Unread anywhere but here. The swap control this replaced badged the one
  // other scope; with a list there is no single "other", so the trigger carries
  // the total and the rows carry the breakdown. Without it you would have to
  // open the menu to find out there was anything to open it for.
  const currentKey = scopeKey(currentScope);
  const unreadElsewhere = useMemo(() => {
    let total = 0;
    for (const [key, thread] of threadsByScope) {
      if (key !== currentKey) total += thread.unreadAssistantCount ?? 0;
    }
    return total;
  }, [threadsByScope, currentKey]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex h-7 min-w-0 items-center gap-1 rounded-md bg-sel px-2 text-xs font-semibold text-foreground"
        // The count goes in the name too: aria-label replaces an element's
        // content for assistive tech, so the badge below is announced by
        // nothing on its own.
        aria-label={
          unreadElsewhere > 0
            ? `Chatting with ${currentLabel}. Choose another, ${unreadElsewhere} unread elsewhere`
            : `Chatting with ${currentLabel}. Choose another`
        }
      >
        <span className="truncate">{currentLabel}</span>
        <UnreadBadge count={unreadElsewhere} />
        <ChevronDown className="h-3 w-3 shrink-0 text-chrome" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] w-64 overflow-y-auto">
        {/* Not DropdownMenuLabel — this module does not export one. */}
        <div className="px-2 py-1.5 label-micro text-chrome select-none">Switch to</div>
        <ScopeRow
          label="Manager"
          active={isCurrent({ type: "manager" })}
          unread={unreadFor({ type: "manager" })}
          onSelect={() => onPick({ type: "manager" })}
        />
        {rows.map((row) => (
          <ScopeRow
            key={row.id}
            label={row.name}
            project={row.project}
            urgency={row.urgency}
            active={isCurrent({ type: "worker", featureId: row.id })}
            unread={unreadFor({ type: "worker", featureId: row.id })}
            onSelect={() => onPick({ type: "worker", featureId: row.id })}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ScopeRow({
  label,
  project,
  urgency,
  active,
  unread,
  onSelect
}: {
  label: string;
  project?: string;
  urgency?: "input" | "review" | "idle";
  active: boolean;
  unread: number;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      // 44px: the touch target this codebase settles on, same as ChangesTab's.
      className={cn("h-11 gap-2.5", active && "bg-sel font-semibold text-foreground")}
    >
      {urgency && <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[urgency])} aria-hidden />}
      <span className="min-w-0 truncate">{label}</span>
      {project && <span className="shrink-0 text-2xs text-faint">{project}</span>}
      {!active && <UnreadBadge count={unread} className="ml-auto" />}
    </DropdownMenuItem>
  );
}
