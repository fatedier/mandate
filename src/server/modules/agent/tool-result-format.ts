export function limitToolText(text: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };
  const omitted = text.length - maxChars;
  return {
    text: `${text.slice(0, maxChars)}... [truncated ${omitted} chars]`,
    truncated: true
  };
}

export function compactToolValue(value: unknown, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (typeof value === "string") return limitToolText(value, maxChars);
  try {
    return limitToolText(JSON.stringify(value) ?? String(value), maxChars);
  } catch {
    return limitToolText(String(value), maxChars);
  }
}
