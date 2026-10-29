import { mandateDesktopConfig } from "./runtime";

function apiBaseUrl(): string {
  return stripTrailingSlash(mandateDesktopConfig()?.apiBaseUrl ?? "");
}

export function apiPath(path: string): string {
  if (isAbsoluteUrl(path)) return path;
  const base = apiBaseUrl();
  return base ? `${base}${ensureLeadingSlash(path)}` : path;
}

export function apiWebSocketPath(path: string): string {
  if (path.startsWith("ws://") || path.startsWith("wss://")) return path;
  const apiBase = apiBaseUrl();
  if (apiBase) {
    const url = new URL(ensureLeadingSlash(path), apiBase);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
  const host = typeof location !== "undefined" ? location.host : "127.0.0.1:4173";
  return `${proto}//${host}${ensureLeadingSlash(path)}`;
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
