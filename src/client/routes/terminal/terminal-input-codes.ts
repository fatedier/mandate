export function controlCodeFromInput(data: string): string | null {
  if (data.length !== 1) return null;
  const code = data.toUpperCase().charCodeAt(0);
  if (code >= 65 && code <= 90) return String.fromCharCode(code - 64);
  if (data === "/") return "\x1f";
  return null;
}
