import { randomBytes } from "node:crypto";

type ShortIdPrefix =
  | "proj"
  | "wkr"
  | "thr"
  | "msg"
  | "wake"
  | "task"
  | "mbx"
  | "cnv"
  | "mem"
  | "drm"
  | "dma"
  | "llm"
  | "cmp"
  | "alm"
  | "mon"
  | "wi"
  | "hof"
  | "pga"
  | "rtab"
  | "nch"
  | "ntf"
  | "sch"
  | "tsk"
  | "note"
  | "cal"
  | "tke"
  | "skl"
  | "skr"
  | "skt"
  | "chg";

export function newId(prefix: ShortIdPrefix): string {
  return `${prefix}_${randomBytes(8).toString("base64url")}`;
}
