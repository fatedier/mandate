export function createTerminalDebugCapture() {
  const enabled = (() => {
    try {
      return localStorage.getItem("terminalDebug") === "1";
    } catch {
      return false;
    }
  })();

  const log: { dir: "in" | "out"; t: number; data: string }[] = [];
  const recordIn = (data: string) => {
    if (enabled) log.push({ dir: "in", t: Date.now(), data });
  };
  const recordOut = (data: string) => {
    if (enabled) log.push({ dir: "out", t: Date.now(), data });
  };

  if (enabled) {
    const escape = (value: string) => Array.from(value).map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f
        ? `\\x${code.toString(16).padStart(2, "0")}`
        : ch;
    }).join("");
    const globals = globalThis as {
      __termDump?: (n?: number) => unknown;
      __termClear?: () => void;
    };
    globals.__termDump = (n = 50) => {
      const slice = n > 0 ? log.slice(-n) : log;
      return slice.map((entry) => ({ dir: entry.dir, t: entry.t, data: escape(entry.data) }));
    };
    globals.__termClear = () => { log.length = 0; };
    console.log("[terminal] debug capture on. __termClear() to reset, __termDump(N) for last N entries");
  }

  return { recordIn, recordOut };
}
