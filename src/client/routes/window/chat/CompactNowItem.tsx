import { useEffect } from "react";
import { FoldVertical } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { scopeKey, useAgentChatStore, type ChatThreadScope } from "@/store/agent-chat";
import { useCommandsStore } from "@/store/commands";
import { useFeatureWakeActive } from "@/store/wake-activity";
import { conversationState } from "./command-draft";
import { COMPACTING_VERB } from "./working-line";

/** Runs /compact from a menu. A menu is in reach where no composer is in
 *  sight (a worker's Plan and Terminal tabs), so what the command answers is
 *  a toast, as every other menu action reports. Taken with nothing to
 *  answer, it has started: said too, in the working line's words, since that
 *  line may not be on screen either. */
async function compactNow(scope: ChatThreadScope): Promise<void> {
  const result = await useCommandsStore.getState().run(scope, "/compact");
  if (result.message) toast.message(result.message);
  else if (result.taken) toast.message(`${COMPACTING_VERB}…`);
}

/** "Compact now" in a conversation's menu: /compact by another door. Greyed
 *  in the states the server says the command cannot run in. */
export function CompactNowItem({ scope }: { scope: ChatThreadScope }) {
  const key = scopeKey(scope);
  const load = useCommandsStore((s) => s.load);
  const blocked = useCommandsStore((s) => s.byScope.get(key)?.find((command) => command.name === "/compact")?.blocked);
  const shown = useAgentChatStore((s) => conversationState(s.threadsByScope.get(key)));
  // A worker's chat is loaded only on its Chat tab, and its menu is in reach
  // from the others: there the page still knows whether its turn is running.
  // Past that, a conversation not loaded here is taken as idle: the server decides.
  const workerRunning = useFeatureWakeActive(scope.type === "worker" ? scope.featureId : "");
  const state = shown === "idle" && workerRunning ? "running" : shown;
  useEffect(() => { void load(scope); }, [load, scope, key]);
  return (
    <DropdownMenuItem disabled={Boolean(blocked?.[state])} onSelect={() => void compactNow(scope)}>
      <FoldVertical className="h-4 w-4" />
      Compact now
    </DropdownMenuItem>
  );
}
