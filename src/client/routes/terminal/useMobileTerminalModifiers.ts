import { useCallback, useRef, useState } from "react";
import { controlCodeFromInput } from "./terminal-input-codes";

export function useMobileTerminalModifiers() {
  const [ctrlActive, setCtrlActive] = useState(false);
  const [altActive, setAltActive] = useState(false);
  const ctrlActiveRef = useRef(false);
  const altActiveRef = useRef(false);

  const clear = useCallback(() => {
    ctrlActiveRef.current = false;
    altActiveRef.current = false;
    setCtrlActive(false);
    setAltActive(false);
  }, []);

  const toggleCtrl = useCallback(() => {
    const next = !ctrlActiveRef.current;
    ctrlActiveRef.current = next;
    setCtrlActive(next);
  }, []);

  const toggleAlt = useCallback(() => {
    const next = !altActiveRef.current;
    altActiveRef.current = next;
    setAltActive(next);
  }, []);

  const transformInput = useCallback((data: string) => {
    const useCtrl = ctrlActiveRef.current;
    const useAlt = altActiveRef.current;
    if (!useCtrl && !useAlt) return data;

    let outgoing = data;
    if (useCtrl) outgoing = controlCodeFromInput(outgoing) ?? outgoing;
    if (useAlt && outgoing) outgoing = `\x1b${outgoing}`;
    clear();
    return outgoing;
  }, [clear]);

  return {
    ctrlActive,
    altActive,
    clear,
    toggleCtrl,
    toggleAlt,
    transformInput
  };
}
