import { randomBytes } from "node:crypto";

export type ShortIdPrefix =
  | "proj"
  | "feat"
  | "thr"
  | "msg"
  | "wake"
  | "task"
  | "mbx"
  | "cnv"
  | "cevt"
  | "mem"
  | "drm"
  | "dma"
  | "llm"
  | "cmp"
  | "alm"
  | "ww"
  | "ui"
  | "hist"
  | "xfer"
  | "wi"
  | "wic";

export function newId(prefix: ShortIdPrefix): string {
  return `${prefix}_${randomBytes(8).toString("base64url")}`;
}
