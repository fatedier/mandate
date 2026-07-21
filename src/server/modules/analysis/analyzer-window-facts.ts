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
  localReason: string;
  hasCodingAgent: boolean;
  agentChildCommands: string[];
  recentOutput: boolean;
  approvalPromptVisible: boolean;
  promptVisible: boolean;
  isPlainShell: boolean;
  isServiceLike: boolean;
  evidence: string[];
}

export interface AnalyzerWindowFacts {
  panes: AnalyzerPaneFacts[];
  primaryFact: AnalyzerPaneFacts | null;
  deterministicStatus: WindowStatus | "";
  deterministicConfidence: number;
  deterministicReason: string;
  deterministicEvidence: string[];
}

export function extractWindowFacts(window: AnalyzerWindowSnapshot): AnalyzerWindowFacts {
  const panes = window.panes.map((pane) => paneFacts(pane));
  const waitingPane = panes.find((pane) => pane.localStatus === "waiting_user");
  const workingPane = panes.find((pane) => pane.localStatus === "working");
  const readyAgentPane = panes.find((pane) => pane.localStatus === "done");
  const servicePane = panes.find((pane) => pane.localStatus === "running_service");
  const allPlainShell = panes.length > 0 && panes.every((pane) => pane.isPlainShell);
  const primaryFact = waitingPane
    ?? workingPane
    ?? readyAgentPane
    ?? servicePane
    ?? panes.find((pane) => pane.pane.paneActive)
    ?? panes[0]
    ?? null;

  if (waitingPane) {
    return decision(panes, waitingPane, "waiting_user", "A pane shows an explicit approval or input prompt.");
  }
  if (workingPane) {
    return decision(panes, workingPane, "working", workingPane.localReason);
  }
  if (readyAgentPane) {
    return decision(panes, readyAgentPane, "done", "A coding agent is present and shows a ready input prompt without active work.");
  }
  if (servicePane && panes.every((pane) => pane.localStatus === "running_service" || pane.localStatus === "idle_shell")) {
    return decision(panes, servicePane, "running_service", "The non-shell pane is a long-running service or watcher.");
  }
  if (allPlainShell) {
    return decision(panes, primaryFact, "idle_shell", "All panes are plain shell prompts with no agent or service process.");
  }

  return {
    panes,
    primaryFact,
    deterministicStatus: "",
    deterministicConfidence: 0,
    deterministicReason: "",
    deterministicEvidence: []
  };
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
  const promptVisible = screen.agentUiChrome.promptVisible;
  const approvalPromptVisible = hasApprovalPrompt(semanticText);
  const currentCommandName = commandName(pane.currentCommand);
  const isPlainShell = isShellLikeCommand(pane.currentCommand)
    && !hasCodingAgent
    && agentChildCommands.length === 0
    && !approvalPromptVisible;
  const isServiceLike = isServiceCommandName(currentCommandName);
  const evidence = [
    ...agentChildCommands,
    ...(recentOutput ? ["pane output still changing"] : []),
    ...(approvalPromptVisible ? ["approval prompt visible"] : []),
    ...(hasCodingAgent ? ["coding agent foreground process"] : [])
  ].slice(0, 4);
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
    localReason: local.reason,
    hasCodingAgent,
    agentChildCommands,
    recentOutput,
    approvalPromptVisible,
    promptVisible: screen.agentUiChrome.promptVisible,
    isPlainShell,
    isServiceLike,
    evidence
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
}): { status: WindowStatus | ""; confidence: number; reason: string } {
  if (input.approvalPromptVisible) {
    return {
      status: "waiting_user",
      confidence: 0.9,
      reason: "The pane shows an explicit approval or input prompt."
    };
  }
  if (input.agentChildCommands.length > 0) {
    return {
      status: "working",
      confidence: 0.88,
      reason: "A coding agent has a foreground child command still running."
    };
  }
  if (input.hasCodingAgent && input.promptVisible && input.recentOutput) {
    // The composer being visible does not mean the agent is idle — agent TUIs
    // keep it on screen while working. Output still moving is the tiebreaker;
    // it replaces the retired progress-verb vocabulary.
    return {
      status: "working",
      confidence: 0.84,
      reason: "A coding agent's screen is still updating."
    };
  }
  if (input.hasCodingAgent && input.promptVisible) {
    return {
      status: "done",
      confidence: 0.78,
      reason: "A coding agent is present and shows a ready prompt without active work."
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
      confidence: 0.65,
      reason: "A coding agent is the foreground process and no input prompt is visible."
    };
  }
  if (input.isServiceLike && !input.hasCodingAgent) {
    return {
      status: "running_service",
      confidence: 0.76,
      reason: "The foreground command is a service-like process."
    };
  }
  if (input.isPlainShell) {
    return {
      status: "idle_shell",
      confidence: 0.86,
      reason: "The pane is a plain shell prompt with no active task."
    };
  }
  return {
    status: "",
    confidence: 0,
    reason: ""
  };
}

function decision(
  panes: AnalyzerPaneFacts[],
  primaryFact: AnalyzerPaneFacts | null | undefined,
  deterministicStatus: WindowStatus,
  deterministicReason: string
): AnalyzerWindowFacts {
  return {
    panes,
    primaryFact: primaryFact ?? null,
    deterministicStatus,
    deterministicConfidence: primaryFact?.localConfidence || 0,
    deterministicReason,
    deterministicEvidence: primaryFact?.evidence ?? []
  };
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
