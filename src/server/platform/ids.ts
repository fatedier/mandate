import { randomBytes } from "node:crypto";

type ShortIdPrefix =
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
  | "mon"
  | "ui"
  | "hist"
  | "xfer"
  | "wi"
  | "wic"
  | "hof"
  | "pga";

export function newId(prefix: ShortIdPrefix): string {
  return `${prefix}_${randomBytes(8).toString("base64url")}`;
}
