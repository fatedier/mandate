export interface TmuxLayoutLeaf {
  layoutPaneId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TmuxLayoutTree {
  x: number;
  y: number;
  width: number;
  height: number;
  leaves: TmuxLayoutLeaf[];
}

export function parseTmuxLayout(layout: unknown): TmuxLayoutTree | null {
  if (typeof layout !== "string" || layout.trim() === "") return null;
  let source = layout.trim();
  if (!/^\d+x\d+,/.test(source)) {
    const comma = source.indexOf(",");
    if (comma < 0) return null;
    source = source.slice(comma + 1);
  }

  let index = 0;
  const leaves: TmuxLayoutLeaf[] = [];

  function readNumber(): number {
    const start = index;
    while (/\d/.test(source[index] ?? "")) index += 1;
    if (start === index) throw new Error("Expected number");
    return Number(source.slice(start, index));
  }

  function expect(char: string): void {
    if (source[index] !== char) throw new Error(`Expected ${char}`);
    index += 1;
  }

  function parseCell(): { x: number; y: number; width: number; height: number } {
    const width = readNumber();
    expect("x");
    const height = readNumber();
    expect(",");
    const x = readNumber();
    expect(",");
    const y = readNumber();
    const next = source[index];

    if (next === ",") {
      index += 1;
      const layoutPaneId = String(readNumber());
      leaves.push({ layoutPaneId, x, y, width, height });
      return { x, y, width, height };
    }

    if (next === "{" || next === "[") {
      const close = next === "{" ? "}" : "]";
      index += 1;
      while (index < source.length && source[index] !== close) {
        parseCell();
        if (source[index] === ",") index += 1;
      }
      expect(close);
      return { x, y, width, height };
    }

    throw new Error("Expected pane id or child layout");
  }

  try {
    const root = parseCell();
    return { ...root, leaves };
  } catch {
    return null;
  }
}
