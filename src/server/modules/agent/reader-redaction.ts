import { redactSecrets } from "../../platform/text/text.js";

/** What another reader of a conversation is never shown: a key, a token, a
 *  password, a private key, a cookie. A history search's results and a
 *  thread read by another agent (read_thread, read_worker_thread) are
 *  given the text with these hidden; the conversation they were written in
 *  keeps them. */
const SENSITIVE_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  { name: "authorization", pattern: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: "Authorization: Bearer [redacted]" },
  { name: "api_key", pattern: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}['"]?/gi, replacement: "$1=[redacted]" },
  { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[redacted private key]" },
  { name: "cookie", pattern: /\b(cookie|set-cookie)\s*:\s*[^\n\r]+/gi, replacement: "$1: [redacted]" }
];

/** The text with every secret hidden, and which kinds were. */
export function redactForReader(text: string): { text: string; flags: string[] } {
  let output = text;
  const flags: string[] = [];
  const platformRedacted = redactSecrets(output);
  if (platformRedacted !== output) {
    flags.push("secret");
    output = platformRedacted;
  }
  for (const rule of SENSITIVE_PATTERNS) {
    if (rule.pattern.test(output)) {
      flags.push(rule.name);
      output = output.replace(rule.pattern, rule.replacement);
    }
    rule.pattern.lastIndex = 0;
  }
  return { text: output, flags: Array.from(new Set(flags)) };
}

/** A property whose name says its value is a secret ("apiKey",
 *  "access_token", "password", "cookie"): its string value is hidden whole. */
const SECRET_NAME = /(api[_-]?key|token|secret|password|passwd|authorization|cookie|private[_-]?key)$/i;

/** A structured value (a command's arguments, a tool's result) with its
 *  secrets hidden, before it becomes JSON: in each of its strings, line by
 *  line (once JSON, a quoted key is escaped past what the patterns read, and
 *  a line's end is no longer one), and whole in a secret-named property's
 *  string, which only its name marks. */
export function redactStringsForReader(value: unknown, name = ""): unknown {
  if (typeof value === "string") return name && SECRET_NAME.test(name) ? "[REDACTED]" : redactForReader(value).text;
  if (Array.isArray(value)) return value.map((item) => redactStringsForReader(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactStringsForReader(inner, key)]));
  }
  return value;
}
