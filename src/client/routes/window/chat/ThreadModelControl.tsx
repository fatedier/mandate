import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { VisuallyHidden } from "radix-ui";
import type { ThreadModelDto } from "@shared/api-contracts";
import { useApi } from "@/hooks/useApi";
import { useIsMobile } from "@/hooks/useIsMobile";
import { api } from "@/lib/api-paths";
import { cn } from "@/lib/utils";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { useThreadModelsStore } from "@/store/thread-models";
import { useWakeModelStore } from "@/store/wake-models";
import { choiceName, modelLabel, shortModelName } from "./thread-model";

const TITLE = "Model for this thread";

/** The thread's model, read from the server: again when the server says it
 *  changed, and on demand (a menu opening: Settings may have moved Default). */
function useThreadModel(threadId: string) {
  const request = useApi();
  const state = useThreadModelsStore((s) => s.byThread.get(threadId) ?? null);
  const revision = useThreadModelsStore((s) => s.revision.get(threadId) ?? 0);
  // Each answer is kept only when no later request's answer is shown (the
  // store's tickets); a read waits for the thread's writes on their way.
  const read = useCallback(async () => {
    await useThreadModelsStore.getState().afterWrites(threadId);
    const ticket = useThreadModelsStore.getState().ticket(threadId);
    const r = await request<{ model: ThreadModelDto }>("GET", api.agentThreadModel(threadId));
    if (r) useThreadModelsStore.getState().put(threadId, r.model, ticket);
  }, [request, threadId]);
  useEffect(() => { void read(); }, [read, revision]);
  // A thread's writes go one at a time.
  const choose = useCallback((ref: string | null) => useThreadModelsStore.getState().queueWrite(threadId, async () => {
    const ticket = useThreadModelsStore.getState().ticket(threadId);
    const r = await request<{ model: ThreadModelDto }>("PUT", api.agentThreadModel(threadId), { model: ref });
    if (r) useThreadModelsStore.getState().put(threadId, r.model, ticket);
  }), [request, threadId]);
  return { state, read, choose };
}

/** The composer's model: the one the thread's turn calls now, else its pick,
 *  else its Default, named in the toolbar; it opens the thread's choices — a
 *  menu, a sheet on a phone. `wakeId`: the thread's running turn, if any. */
export function ThreadModelControl({ threadId, wakeId }: { threadId: string; wakeId: string | null }) {
  const { state, read, choose } = useThreadModel(threadId);
  const live = useWakeModelStore((s) => (wakeId ? s.byWake.get(wakeId) ?? null : null));
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!state) return null;
  const label = modelLabel(state, live);
  const picked = state.override?.ref ?? "";
  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      data-slot="thread-model"
      aria-label={`${TITLE}: ${label}`}
      title={(live ?? state.override ?? state.default).ref}
      onClick={isMobile ? () => { void read(); setSheetOpen(true); } : undefined}
      // Its touch area grows past it (hit), as the toolbar's other buttons'
      // do: a taller button would make the composer taller on a touch screen.
      className="hit relative flex h-7 min-w-0 max-w-[16rem] items-center gap-0.5 rounded-md px-1.5 text-2xs text-muted-foreground transition-colors hover:bg-sel hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span data-slot="thread-model-name" className="truncate">{label}</span>
      <ChevronDown className="size-3 shrink-0" aria-hidden />
    </button>
  );

  if (isMobile) {
    const pick = (ref: string | null) => { setSheetOpen(false); void choose(ref); };
    return (
      <>
        {trigger}
        <BottomSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          slot="thread-model-sheet"
          // The name opened it without being its trigger: focus goes back there.
          returnFocus={() => triggerRef.current}
          bodyClassName="px-2 pb-3"
          header={
            <>
              <VisuallyHidden.Root><BottomSheetTitle>{TITLE}</BottomSheetTitle></VisuallyHidden.Root>
              <div className="flex h-8 shrink-0 items-center px-4 text-xs text-muted-foreground">{TITLE}</div>
            </>
          }
        >
          {/* A menu, as on a desktop: a pick closes it. One tab stop (the
              checked choice); the arrows, Home and End move among them. */}
          <div role="menu" aria-label={TITLE} onKeyDown={moveAmongChoices} className="flex flex-col">
            <SheetChoice checked={picked === ""} onPick={() => pick(null)} name="Default" note={shortModelName(state.default.model)} />
            {state.choices.map((group) => (
              <div key={group.providerName} role="group" aria-label={group.providerName} className="flex flex-col">
                <div aria-hidden className="px-2 pt-3 pb-1 text-2xs text-faint">{group.providerName}</div>
                {group.models.map((model) => (
                  <SheetChoice key={model.ref} checked={picked === model.ref} onPick={() => pick(model.ref)} name={choiceName(model, group.models)} />
                ))}
              </div>
            ))}
          </div>
        </BottomSheet>
      </>
    );
  }

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) void read(); }}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-56">
        <DropdownMenuLabel>{TITLE}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={picked} onValueChange={(value) => void choose(value || null)}>
          <DropdownMenuRadioItem value="">
            <span className="flex-1">Default</span>
            <span className="text-2xs text-faint">{shortModelName(state.default.model)}</span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {state.choices.map((group) => (
            <DropdownMenuGroup key={group.providerName}>
              <DropdownMenuLabel>{group.providerName}</DropdownMenuLabel>
              {group.models.map((model) => (
                <DropdownMenuRadioItem key={model.ref} value={model.ref}>{choiceName(model, group.models)}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The arrows, Home and End move focus among a menu's choices. */
function moveAmongChoices(event: React.KeyboardEvent<HTMLElement>): void {
  const choices = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  const at = choices.indexOf(document.activeElement as HTMLElement);
  const last = choices.length - 1;
  const next = event.key === "ArrowDown" ? (at + 1) % choices.length
    : event.key === "ArrowUp" ? (at <= 0 ? last : at - 1)
    : event.key === "Home" ? 0
    : event.key === "End" ? last
    : -1;
  if (next < 0) return;
  event.preventDefault();
  choices[next]?.focus();
}

function SheetChoice({ checked, onPick, name, note }: { checked: boolean; onPick: () => void; name: string; note?: string }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      onClick={onPick}
      className={cn("flex min-h-11 items-center gap-2.5 rounded-lg px-2 text-left text-sm", checked && "bg-sel")}
    >
      <span className="w-4 shrink-0 text-center" aria-hidden>{checked ? "✓" : ""}</span>
      <span className="flex-1 truncate">{name}</span>
      {note && <span className="text-xs text-faint">{note}</span>}
    </button>
  );
}
