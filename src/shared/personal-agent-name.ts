/** The personal agent's name: the user sets it; until
 *  then it is "" and the guide shows. */
export const PERSONAL_AGENT_NAME_MAX = 40;
export const DEFAULT_PERSONAL_AGENT_NAME = "Mandate";

/** One trimmed line; "" when blank or not a string; null when too long. */
export function normalizePersonalAgentName(raw: unknown): string | null {
  if (typeof raw !== "string") return "";
  const name = raw.replace(/\s+/g, " ").trim();
  return name.length > PERSONAL_AGENT_NAME_MAX ? null : name;
}

export function displayPersonalAgentName(name: string): string {
  return name || DEFAULT_PERSONAL_AGENT_NAME;
}
