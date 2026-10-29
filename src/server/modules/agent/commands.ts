import type {
  AgentCommandDto, AgentCommandState, AgentRunCommandRequest, AgentRunCommandResponse
} from "../../../shared/api/agents.js";
import { formatTokenCount } from "../../../shared/format-tokens.js";
import type { ManualCompactionOutcome } from "./compression.js";

/** What a command may do to the conversation it was typed in. Built per
 *  request by the HTTP service; a command never reaches past it. */
export interface CommandHost {
  /** Starts a compaction by hand. */
  compact(): ManualCompactionOutcome;
  /** Whether a compaction started by hand has the thread now. */
  compacting(): boolean;
  /** Cancels the running turn; false when none is running. */
  stop(): boolean;
  /** The window's measured size against the compression threshold. Null when
   *  the server has no threshold to measure against. `sinceCompaction`: no
   *  call has measured it since it was last compacted. */
  contextUsage(): { inputTokens: number | null; budgetTokens: number; sinceCompaction: boolean } | null;
}

interface AgentCommand {
  name: string;
  description: string;
  /** The states it cannot run in, with the short reason a composer's list
   *  shows beside it. A hint for the page: `run` decides for itself. */
  blocked: Partial<Record<AgentCommandState, string>>;
  run(host: CommandHost): AgentRunCommandResponse;
}

const done = (message: string | null = null): AgentRunCommandResponse => ({ taken: true, message });
const refused = (message: string): AgentRunCommandResponse => ({ taken: false, message });

/** Every command a conversation's composer runs. A command is not a message:
 *  it appends nothing and the model never sees it. All of their copy is here,
 *  so another client prints the same words. None takes text or attachments. */
const AGENT_COMMANDS: readonly AgentCommand[] = [
  {
    name: "/compact",
    description: "Summarize earlier messages to free up context",
    blocked: { running: "A turn is running", compacting: "Already compacting" },
    run(host) {
      const outcome = host.compact();
      if (outcome === "started") return done();
      if (outcome === "nothing") return done("Nothing to compact yet.");
      // Worth the same draft again later, so it stays in the box.
      return refused(outcome === "compacting" ? "Already compacting." : "A turn is running. Try again when it finishes.");
    }
  },
  {
    name: "/stop",
    description: "Stop the running turn",
    blocked: { idle: "Nothing is running", compacting: "A compaction can't be stopped" },
    run(host) {
      if (host.stop()) return done();
      return done(host.compacting() ? "A compaction can't be stopped once it has started." : "Nothing is running.");
    }
  },
  {
    name: "/context",
    description: "Show how much context is in use",
    blocked: {},
    run(host) {
      const usage = host.contextUsage();
      if (usage?.inputTokens) {
        return done(`Context: ${formatTokenCount(usage.inputTokens)} of ${formatTokenCount(usage.budgetTokens)} tokens`);
      }
      return done(usage?.sinceCompaction
        ? "Not measured since the compaction. The next reply measures it."
        : "Not measured yet. The next reply measures it.");
    }
  }
];

/** The command a draft names — its first word, exactly — and what follows it.
 *  Null for everything else: `/tmp/foo is broken` is a message. */
export function parseCommandDraft(text: string): { command: AgentCommand; rest: string } | null {
  const trimmed = text.trim();
  const first = trimmed.split(/\s+/, 1)[0] ?? "";
  const command = AGENT_COMMANDS.find((candidate) => candidate.name === first);
  return command ? { command, rest: trimmed.slice(first.length).trim() } : null;
}

export function listAgentCommands(): AgentCommandDto[] {
  return AGENT_COMMANDS.map(({ name, description, blocked }) => ({ name, description, blocked }));
}

/** Runs a draft as a command. Null when it is not one. */
export function runAgentCommand(input: AgentRunCommandRequest, host: CommandHost): AgentRunCommandResponse | null {
  const parsed = parseCommandDraft(input.text);
  if (!parsed) return null;
  if (parsed.rest) return refused(`${parsed.command.name} takes no text after it.`);
  if (input.attachments > 0) return refused(`${parsed.command.name} takes no attachments.`);
  return parsed.command.run(host);
}
