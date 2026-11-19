import { useAgentChatStore } from "./agent-chat";
import { useAgentPageUi } from "./agent-page-ui";
import { usePersonalAgentStore } from "./personal-agent";

// History's rows stay loaded while its tab is open: shown or not, and on
// Personal agent's page or another (its place is not trimmed away meanwhile).
// Kept here, not in a component, so leaving the page does not let them go.
let held: { key: string; release: () => void } | null = null;

function holdWhileOpen(): void {
  const threadId = usePersonalAgentStore.getState().agent?.threadId ?? null;
  const key = useAgentPageUi.getState().history && threadId ? `personal:${threadId}` : null;
  if (key === (held?.key ?? null)) return;
  held?.release();
  held = key ? { key, release: useAgentChatStore.getState().holdWhole(key) } : null;
}

useAgentPageUi.subscribe(holdWhileOpen);
usePersonalAgentStore.subscribe(holdWhileOpen);
holdWhileOpen();
