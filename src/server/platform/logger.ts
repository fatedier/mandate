import { formatErrorMessage, isKnownOperationalError } from "./errors.js";

const MAX_LOG_ERROR_LENGTH = 1200;
let processHandlersInstalled = false;
const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};
let configuredLogLevel: LogLevel | null = null;

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
  return envLogLevel() ?? configuredLogLevel ?? "info";
}

export function formatLogError(error: unknown, fallback = "operation failed"): string {
  const message = formatErrorMessage(error, fallback)
    .replace(/\s+/g, " ")
    .trim();
  if (message.length <= MAX_LOG_ERROR_LENGTH) return message;
  return `${message.slice(0, MAX_LOG_ERROR_LENGTH)}...[truncated ${message.length - MAX_LOG_ERROR_LENGTH} chars]`;
}

export function logError(scope: string, error: unknown, fallback = "operation failed"): void {
  if (shouldLog("error")) {
    console.error(`[mandate] ${scope}: ${formatLogError(error, fallback)}`);
  }
  if (!shouldLog("debug") || !shouldLogStacks() || isKnownOperationalError(error)) return;
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

function envLogLevel(): LogLevel | null {
  const level = parseLogLevel(process.env.MANDATE_LOG_LEVEL);
  if (level) return level;
  return debugEnvEnabled() ? "debug" : null;
}

export function debugEnvEnabled(): boolean {
  const debug = (process.env.MANDATE_DEBUG ?? "").trim().toLowerCase();
  return debug === "1" || debug === "true";
}

function shouldLogStacks(): boolean {
  const value = (process.env.MANDATE_LOG_STACKS ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}
