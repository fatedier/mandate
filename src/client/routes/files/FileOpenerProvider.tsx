import type { ReactNode } from "react";
import type { FileTarget } from "@/lib/file-link";
import { FileOpenerContext } from "./file-opener";

/** A page with a panel: the files linked inside it open in its panel. */
export function FileOpenerProvider({ open, children }: { open: (target: FileTarget) => void; children: ReactNode }) {
  return <FileOpenerContext.Provider value={open}>{children}</FileOpenerContext.Provider>;
}
