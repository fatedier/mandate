/** Long enough for a provider sentence, short enough that one reason cannot
 *  take over the panel it is listed in. */
const MAX_REASON_CHARS = 120;

/** A code is a token — `500`, `rate_limit_exceeded`. It is provider-controlled
 *  and gets its own bound, because the message is budgeted against whatever it
 *  costs: unbounded, a long code drives the remaining width negative and the
 *  message is sliced away to nothing. */
const MAX_CODE_CHARS = 24;

/** Only these are stripped. A general "cut at the first colon" also cuts
 *  `https://`, which turned a support URL into `//chatgpt.com/cyber`. */
const SDK_PREFIX = /^(?:litellm\.\w+|openai\.\w+|APIError)\s*:\s*/;

/** The provider's own error, dug out of whatever wrapper carried it. */
export interface EmbeddedProviderError {
  /** The provider's message, SDK prefix stripped. Empty if it sent none. */
  message: string;
  /** The provider's code verbatim — `"500"`, `"rate_limit_exceeded"`. */
  code: string | null;
}

/**
 * The provider's error object, when it arrives as JSON text inside another
 * error's message.
 *
 * A provider that answers down the streaming channel gets its payload matched
 * against the delta schema; the SDK fails that match and throws a type
 * validation error carrying only `{name, message}`. Everything the provider
 * actually said — its message and its status — survives only as text in there.
 *
 * Both readers of this need the same parse: the activity surface wants the
 * message, the retry policy wants the code. Parsing it twice is how they drift.
 */
export function embeddedProviderError(raw: string | null | undefined): EmbeddedProviderError | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  const start = text.indexOf('{"error"');
  if (start < 0) return null;
  const end = text.indexOf("}}", start);
  if (end <= start) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end + 2)) as {
      error?: { message?: unknown; code?: unknown };
    };
    const message =
      typeof parsed.error?.message === "string"
        ? parsed.error.message.replace(SDK_PREFIX, "").trim()
        : "";
    const rawCode = parsed.error?.code;
    return {
      message,
      code: rawCode === undefined || rawCode === null ? null : String(rawCode)
    };
  } catch {
    // Truncated or malformed payload. Callers fall back to the wrapper text,
    // which at least identifies what failed.
    return null;
  }
}

/**
 * The readable reason a call failed.
 *
 * When a provider answers an error object down the streaming channel, the SDK
 * matches it against the delta schema, fails, and records the whole thing —
 * wrapper, payload, and a few hundred lines of Zod output. The reason worth
 * showing is the provider's own message inside that payload. Without that
 * unwrap, every wrapped failure collapses to the same Zod wrapper line.
 */
export function unwrapErrorReason(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return "(no message)";

  const embedded = embeddedProviderError(text);
  if (embedded?.message) {
    const suffix = formatCode(embedded.code);
    return clamp(embedded.message, MAX_REASON_CHARS - suffix.length) + suffix;
  }

  return clamp(text.split("\n", 1)[0]!.trim(), MAX_REASON_CHARS);
}

/**
 * The string `unwrapErrorReason` expects, out of whatever a surface is holding.
 *
 * The server groups on `json_extract(error_json, '$.message')` falling back to
 * the whole column; a client holds the same thing already parsed, as
 * `{name?, message}`. Passing that object straight to `String()` yields
 * "[object Object]" — the same reason on three surfaces has to be reached the
 * same way, so this is the one converter in front of the unwrapper.
 */
export function errorMessageText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    return JSON.stringify(error);
  }
  return String(error ?? "");
}

function formatCode(code: unknown): string {
  if (code === undefined || code === null) return "";
  const token = String(code).trim().replace(/\s+/g, " ");
  return token ? ` (${clamp(token, MAX_CODE_CHARS)})` : "";
}

function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  // Below two characters there is no room for the ellipsis, and `max - 1` would
  // become a negative slice index — which counts back from the end and returns
  // more than it was asked for, not less.
  if (max <= 1) return value.slice(0, Math.max(0, max));
  return `${value.slice(0, max - 1)}…`;
}
