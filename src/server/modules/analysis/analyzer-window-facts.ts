import path from "node:path";
import type { WindowStatus } from "../../platform/tmux/tmux-types.js";
import type { AnalyzerPaneSnapshot, AnalyzerWindowSnapshot } from "./analyzer-contracts.js";
import { isRecentOutput, screenForAnalysis } from "./analyzer-utils.js";

interface AnalyzerPaneFacts {
  pane: AnalyzerPaneSnapshot;
  paneId: string;
  paneIndex: number;
  currentCommand: string;
  localStatus: WindowStatus | "";
  localConfidence: number;
  hasCodingAgent: boolean;
  agentChildCommands: string[];
  recentOutput: boolean;
  approvalPromptVisible: boolean;
  promptVisible: boolean;
  isPlainShell: boolean;
  isServiceLike: boolean;
}

/** Each pane's facts and, when a heuristic matched, the window's status
 *  ("" when none matched). */
export interface AnalyzerWindowFacts {
  panes: AnalyzerPaneFacts[];
  status: WindowStatus | "";
}

export function extractWindowFacts(window: AnalyzerWindowSnapshot): AnalyzerWindowFacts {
  const panes = window.panes.map((pane) => paneFacts(pane));
  return { panes, status: windowStatus(panes) };
}

/** A pane asking for input, then one at work, then an agent ready for input,
 *  then services (beside shells only), then all plain shells. */
function windowStatus(panes: AnalyzerPaneFacts[]): WindowStatus | "" {
  const any = (status: WindowStatus) => panes.some((pane) => pane.localStatus === status);
  if (any("waiting_user")) return "waiting_user";
  if (any("working")) return "working";
  if (any("done")) return "done";
  if (any("running_service") && panes.every((pane) => pane.localStatus === "running_service" || pane.localStatus === "idle_shell")) {
    return "running_service";
  }
  if (panes.length > 0 && panes.every((pane) => pane.isPlainShell)) return "idle_shell";
  return "";
}

function agentChildForegroundCommands(pane: AnalyzerPaneSnapshot): string[] {
  const foreground = pane.foregroundProcesses || [];
  const agentPids = new Set(
    foreground
      .filter((process) => Number.isFinite(process.pid) && isCodingAgentCommand(process.command))
      .map((process) => process.pid)
  );
  if (agentPids.size === 0) {
    return [];
  }

  return foreground
    .filter((process) => Number.isFinite(process.ppid) && agentPids.has(process.ppid))
    .map((process) => process.command)
    .filter((command) => command && !isCodingAgentCommand(command) && !isShellLikeCommand(command));
}

function paneFacts(pane: AnalyzerPaneSnapshot): AnalyzerPaneFacts {
  const screen = screenForAnalysis(pane.styledCapture || pane.capture);
  const semanticText = screen.semanticText;
  const foreground = pane.foregroundProcesses || [];
  const hasCodingAgent = foreground.some((process) => isCodingAgentCommand(process.command));
  const agentChildCommands = agentChildForegroundCommands(pane);
  const recentOutput = isRecentOutput(pane.changedAt);
  const promptVisible = screen.promptVisible;
  const approvalPromptVisible = hasApprovalPrompt(semanticText);
  const currentCommandName = commandName(pane.currentCommand);
  const isPlainShell = isShellLikeCommand(pane.currentCommand)
    && !hasCodingAgent
    && agentChildCommands.length === 0
    && !approvalPromptVisible;
  const isServiceLike = isServiceCommandName(currentCommandName);
  const local = paneLocalStatus({
    approvalPromptVisible,
    agentChildCommands,
    recentOutput,
    hasCodingAgent,
    promptVisible,
    isPlainShell,
    isServiceLike
  });

  return {
    pane,
    paneId: pane.paneId,
    paneIndex: pane.paneIndex,
    currentCommand: pane.currentCommand,
    localStatus: local.status,
    localConfidence: local.confidence,
    hasCodingAgent,
    agentChildCommands,
    recentOutput,
    approvalPromptVisible,
    promptVisible,
    isPlainShell,
    isServiceLike
  };
}

function paneLocalStatus(input: {
  approvalPromptVisible: boolean;
  agentChildCommands: string[];
  recentOutput: boolean;
  hasCodingAgent: boolean;
  promptVisible: boolean;
  isPlainShell: boolean;
  isServiceLike: boolean;
}): { status: WindowStatus | ""; confidence: number } {
  if (input.approvalPromptVisible) {
    return {
      status: "waiting_user",
      confidence: 0.9
    };
  }
  if (input.agentChildCommands.length > 0) {
    return {
      status: "working",
      confidence: 0.88
    };
  }
  if (input.hasCodingAgent && input.promptVisible && input.recentOutput) {
    // The composer being visible does not mean the agent is idle — agent TUIs
    // keep it on screen while working. Output still moving is the tiebreaker.
    return {
      status: "working",
      confidence: 0.84
    };
  }
  if (input.hasCodingAgent && input.promptVisible) {
    return {
      status: "done",
      confidence: 0.78
    };
  }
  // Structural fallback: a coding agent is the foreground process and no
  // input prompt is visible — the agent is mid-step (LLM call in flight,
  // file edit, command run, etc.) even if no child process is spawned and
  // no progress chrome is recognized by text heuristics. This catches
  // Codex/Claude Code 'thinking' between turns without parsing UI text.
  if (input.hasCodingAgent) {
    return {
      status: "working",
      confidence: 0.65
    };
  }
  if (input.isServiceLike && !input.hasCodingAgent) {
    return {
      status: "running_service",
      confidence: 0.76
    };
  }
  if (input.isPlainShell) {
    return {
      status: "idle_shell",
      confidence: 0.86
    };
  }
  return { status: "", confidence: 0 };
}

function hasApprovalPrompt(text: string) {
  return [
    /\bThis command requires approval\b/i,
    /\bDo you want to proceed\?/i,
    /\bWaiting[.….]*$/im,
    /\bapprove\b.*\b(?:command|request|action)\b/i,
    /\b(?:press|hit)\s+(?:enter|return)\b/i,
    /需要.*(?:确认|批准|审批|输入)/,
    /等待.*(?:确认|批准|审批|输入)/
  ].some((pattern) => pattern.test(text));
}

function isCodingAgentCommand(command: string) {
  const name = commandName(command);
  if (["claude", "codex", "opencode", "aider", "gemini"].includes(name)) {
    return true;
  }
  return /(?:^|[\/\s@._-])(?:claude|codex|opencode|aider|gemini)(?:$|[\/\s@._-])/i.test(String(command ?? ""));
}

function isShellLikeCommand(command: string) {
  return ["sh", "bash", "zsh", "fish", "tmux", "screen"].includes(commandName(command));
}

function isServiceCommandName(command: string) {
  return [
    "vite", "next", "webpack", "wrangler", "node", "bun", "deno", "python", "go", "cargo", "npm", "pnpm", "yarn", "ssh"
  ].includes(command);
}

function commandName(command: string) {
  const first = String(command ?? "").trim().split(/\s+/)[0] ?? "";
  return path.basename(first).replace(/^-+/, "").toLowerCase();
}
