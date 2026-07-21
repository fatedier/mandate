import { useAgentChatStore, scopeKey, type AgentChatScope } from "@/store/agent-chat";
import { useRouteFeature } from "@/hooks/useRouteFeature";

/**
 * Shared wiring for the two controls that open the assistant dock: the top-bar
 * trigger and the collapsed right rail.
 *
 * They must agree on which scope they are about. The rail used to badge the sum
 * of every thread's unread count while its click opened only the current
 * route's scope — so clearing one thread left the badge showing the others, and
 * a user who had read what they were shown was told there was still something
 * unread. The badge now counts exactly what the click will open.
 *
 * That also matches the rule the rest of the app follows: a signal stays with
 * the thing it belongs to rather than being aggregated into a global tally.
 */
export function useChatTrigger(): {
  targetScope: AgentChatScope;
  unread: number;
  label: string;
} {
  const routeFeature = useRouteFeature();
  const targetScope: AgentChatScope = routeFeature
    ? { type: "worker", featureId: routeFeature.id }
    : { type: "manager" };
  const key = scopeKey(targetScope);
  const unread = useAgentChatStore(
    (s) => s.threadsByScope.get(key)?.unreadAssistantCount ?? 0
  );
  const label = routeFeature ? `Open ${routeFeature.name} chat` : "Open manager chat";
  return { targetScope, unread, label };
}
