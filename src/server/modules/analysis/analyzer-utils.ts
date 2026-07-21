import { stripAnsi } from "../../platform/text/text.js";

export function limitText(value: unknown, maxLength: number) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}...`;
}

/** How recently a pane's content must have changed to count as "output is
 *  still moving". Agent TUIs redraw their timer/spinner chrome every second
 *  while work is in flight, so this is a vendor-independent activity signal —
 *  unlike the retired progress-verb vocabulary, it needs no updates when a
 *  CLI ships new wording. Threshold is a few poll cycles so a single missed
 *  capture doesn't flicker the state. */
export const RECENT_OUTPUT_MS = 10_000;

export function isRecentOutput(changedAt: string | undefined, nowMs = Date.now()): boolean {
  if (!changedAt) return false;
  const changedMs = Date.parse(changedAt);
  if (!Number.isFinite(changedMs)) return false;
  return nowMs - changedMs < RECENT_OUTPUT_MS;
}

export function screenForAnalysis(text: unknown) {
  const lines = String(text ?? "").split("\n");
  const kept = [];
  const suggestions = [];
  const footers = [];
  let promptVisible = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const plain = stripAnsi(line).trim();
    if (isAgentSuggestionLine(line, plain, lines, index)) {
      promptVisible = true;
      suggestions.push(plain.replace(/^›\s*/, ""));
      continue;
    }
    if (isAgentFooterLine(line, plain)) {
      footers.push(plain);
      continue;
    }
    kept.push(stripAnsi(line));
  }

  return {
    semanticText: kept.join("\n"),
    agentUiChrome: {
      promptVisible,
      suggestions: suggestions.slice(-4),
      footers: footers.slice(-2)
    }
  };
}

function isAgentSuggestionLine(line: string, plain: string, lines: string[], index: number) {
  if (!plain.startsWith("› ")) {
    return false;
  }
  if (hasAnsiFaint(line)) {
    return true;
  }
  if (/\B@[A-Za-z0-9_.-]+/.test(plain)) {
    return true;
  }
  return lines.slice(index + 1, index + 4).some((nextLine) => isAgentFooterLine(nextLine, stripAnsi(nextLine).trim()));
}

function isAgentFooterLine(line: string, plain: string) {
  return /\bContext\s+\d+%\s+used\b/.test(plain) && /(?:^|\s)·(?:\s|$)/.test(plain) && (hasAnsiFaint(line) || line === plain);
}

function hasAnsiFaint(line: string) {
  for (const match of String(line ?? "").matchAll(/\x1B\[([0-9;]*)m/g)) {
    const codes = (match[1] ?? "").split(";").filter(Boolean);
    for (let index = 0; index < codes.length; index += 1) {
      if (codes[index] === "38" || codes[index] === "48") {
        if (codes[index + 1] === "2") {
          index += 4;
        } else if (codes[index + 1] === "5") {
          index += 2;
        }
        continue;
      }
      if (codes[index] === "2") {
        return true;
      }
    }
  }
  return false;
}
