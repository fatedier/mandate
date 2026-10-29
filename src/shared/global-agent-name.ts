/** The global agent's name: the user sets it; until
 *  then it is "" and the guide shows. */
export const GLOBAL_AGENT_NAME_MAX = 40;
export const DEFAULT_GLOBAL_AGENT_NAME = "Mandate";

/** One trimmed line; "" when blank or not a string; null when too long. */
export function normalizeGlobalAgentName(raw: unknown): string | null {
  if (typeof raw !== "string") return "";
  const name = raw.replace(/\s+/g, " ").trim();
  return name.length > GLOBAL_AGENT_NAME_MAX ? null : name;
}

export function displayGlobalAgentName(name: string): string {
  return name || DEFAULT_GLOBAL_AGENT_NAME;
}
