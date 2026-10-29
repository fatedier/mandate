import type { ApiErrorResponse } from "./common.js";

export type StorageStatusResponse =
  | { ok: true; databaseBytes: number }
  | ApiErrorResponse;

export type StorageCleanupResponse =
  | { ok: true; truncated: number; bytesBefore: number; bytesAfter: number }
  | ApiErrorResponse;
