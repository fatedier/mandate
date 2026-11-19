import { useCallback, useRef, useState } from "react";
import type { MemoryDreamActionDto, MemoryDreamRunDetailResponse, MemoryDreamRunDto } from "@shared/api-contracts";
import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";
import { errorText } from "@shared/error-text";
import { DreamRunDialog } from "./DreamRunDialog";

type Detail = Extract<MemoryDreamRunDetailResponse, { run: MemoryDreamRunDto }>;

/** One run's detail in its dialog: what Overview's partition rows and
 *  Activity's dream cards both open. */
export function useRunDialog(resolveProject?: (projectId: string) => string | undefined) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  // Only the run picked last answers: an earlier pick landing later must
  // not replace it, nor report its failure.
  const pickSeq = useRef(0);
  const openRun = useCallback(async (run: MemoryDreamRunDto) => {
    const seq = ++pickSeq.current;
    setError("");
    try {
      const payload = await readJson<MemoryDreamRunDetailResponse>(await fetch(api.memoryDreamRun(run.id)));
      if (seq !== pickSeq.current || !("run" in payload)) return;
      setDetail(payload);
      setOpen(true);
    } catch (err) {
      if (seq === pickSeq.current) setError(errorText(err));
    }
  }, []);

  const dialog = (
    <DreamRunDialog
      open={open}
      onOpenChange={setOpen}
      run={detail?.run ?? null}
      actions={detail?.actions ?? NO_ACTIONS}
      brief={detail?.brief ?? null}
      resolveProject={resolveProject}
    />
  );
  return { openRun, dialog, error };
}

const NO_ACTIONS: MemoryDreamActionDto[] = [];
