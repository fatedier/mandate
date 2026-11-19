import { formatErrorMessage, isKnownOperationalError } from "./errors.js";

const MAX_LOG_ERROR_LENGTH = 1200;
let processHandlersInstalled = false;
export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};
let configuredLogLevel: LogLevel | null = null;
let stacksOn = false;

export type LogLevel = typeof LOG_LEVELS[number];

export function parseLogLevel(value: unknown): LogLevel | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return LOG_LEVELS.includes(normalized as LogLevel) ? normalized as LogLevel : null;
}

export function normalizeLogLevel(value: unknown, fallback: LogLevel = "info"): LogLevel {
  return parseLogLevel(value) ?? fallback;
}

export function setLogLevel(value: unknown): LogLevel {
  configuredLogLevel = normalizeLogLevel(value);
  return configuredLogLevel;
}

export function getLogLevel(): LogLevel {
  return configuredLogLevel ?? "info";
}

/** Whether an error logged at debug also prints its stack (config.json's
 *  logging.stacks). */
export function setLogStacks(on: boolean): void {
  stacksOn = on === true;
}

export function logStacks(): boolean {
  return stacksOn;
}

export function formatLogError(error: unknown, fallback = "operation failed"): string {
  const message = formatErrorMessage(error, fallback)
    .replace(/\s+/g, " ")
    .trim();
  if (message.length <= MAX_LOG_ERROR_LENGTH) return message;
  return `${message.slice(0, MAX_LOG_ERROR_LENGTH)}...[truncated ${message.length - MAX_LOG_ERROR_LENGTH} chars]`;
}

/** `context` is what was being done (a path, a thread): it comes before the
 *  error's own words, and alone when the error has none. */
export function logError(scope: string, error: unknown, context?: string): void {
  if (shouldLog("error")) {
    const words = formatLogError(error, "");
    const text = context ? (words ? `${context}: ${words}` : context) : (words || "operation failed");
    console.error(`[mandate] ${scope}: ${text}`);
  }
  if (!shouldLog("debug") || !stacksOn || isKnownOperationalError(error)) return;
  const stack = error instanceof Error ? error.stack : "";
  if (stack) console.error(stack);
}

export function installProcessErrorHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;

  process.on("unhandledRejection", (reason) => {
    logError("unhandledRejection", reason, "unhandled promise rejection");
  });

  process.on("uncaughtException", (error) => {
    logError("uncaughtException", error, "uncaught exception");
    process.exitCode = 1;
  });
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_WEIGHT[level] <= LOG_LEVEL_WEIGHT[getLogLevel()];
}
