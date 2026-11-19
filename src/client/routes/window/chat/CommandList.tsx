import type { AgentCommandDto, AgentCommandState } from "@shared/api-contracts";
import { cn } from "@/lib/utils";
import { ComposerList } from "./ComposerList";

/** The commands a draft could still become, over the composer. A press on a
 *  row fills its command in and does not run it. A command that cannot run
 *  in the conversation's present state stays, greyed, with the reason. */
export function CommandList({ id, commands, picked, state, onPick }: {
  id: string;
  commands: readonly AgentCommandDto[];
  picked: number;
  state: AgentCommandState;
  onPick: (name: string) => void;
}) {
  return (
    <ComposerList
      id={id}
      label="Commands"
      picked={picked}
      rowClassName="items-baseline gap-2.5 pointer-coarse:items-center"
      // An option's key is its name without the slash, as its id has always been.
      onPick={(key) => onPick(`/${key}`)}
      groups={[{
        options: commands.map((command) => {
          const why = command.blocked[state];
          return {
            key: command.name.slice(1),
            ...(why ? { attributes: { "data-blocked": "" } } : {}),
            content: (
              <>
                <span className={cn("shrink-0 font-mono text-[13px]", why ? "text-faint" : "text-foreground")}>{command.name}</span>
                <span className={cn("min-w-0 flex-1 truncate text-xs pointer-coarse:whitespace-normal", why ? "text-faint" : "text-muted-foreground")}>{command.description}</span>
                {why && <span className="shrink-0 text-2xs text-faint">{why}</span>}
              </>
            )
          };
        })
      }]}
    />
  );
}
