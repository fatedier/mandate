import { useId } from "react";
import type { TerminalDisplay } from "@/store/ui";
import { TERMINAL_THEME } from "@/hooks/terminal/terminal-theme";

/** A small screen showing the choice: lines that fit it, run past its edge,
 *  or shrink to fit; Auto, two screens and a turn between them. Drawn in
 *  the terminal's own colours, as it always is dark. */
export function DisplayPicture({ display }: { display: TerminalDisplay }) {
  const clip = useId();
  const line = TERMINAL_THEME.blue;
  const screen = (x: number, y: number, w: number, h: number) => (
    <rect x={x} y={y} width={w} height={h} rx={2.5} fill={TERMINAL_THEME.background} stroke="currentColor" strokeOpacity={0.4} />
  );
  const lines = (x: number, y: number, w: number, n: number, gap: number, color = line) =>
    Array.from({ length: n }, (_, i) => <rect key={i} x={x} y={y + i * gap} width={i % 3 === 2 ? w * 0.6 : w} height={1.6} rx={0.8} fill={color} />);
  return (
    <svg viewBox="0 0 36 24" aria-hidden className="size-6 w-9">
      {display === "auto" && (
        <>
          {screen(1, 4, 15, 19)}{lines(4, 8, 9, 4, 3.4)}
          {screen(20, 1, 15, 11)}{lines(23, 4, 9, 2, 3.4, TERMINAL_THEME.foreground)}
          <path d="M23 16c2.5 4 7 4 9.5 0m-1.8-.4 1.8.4.5-1.9" fill="none" stroke="currentColor" strokeWidth={1.3} />
        </>
      )}
      {display === "screen" && <>{screen(6, 1, 24, 22)}{lines(9, 5, 18, 5, 3.4)}</>}
      {display === "pane" && (
        <>
          {screen(6, 1, 24, 22)}
          <clipPath id={clip}><rect x={6} y={1} width={24} height={22} rx={2.5} /></clipPath>
          <g clipPath={`url(#${clip})`}>{lines(9, 5, 34, 5, 3.4)}</g>
          <path d="M31.5 12h3.5m-1.4-1.4 1.4 1.4-1.4 1.4" fill="none" stroke="currentColor" strokeWidth={1.2} />
        </>
      )}
      {display === "small" && <>{screen(6, 1, 24, 22)}{lines(8, 4, 20, 9, 1.9)}</>}
    </svg>
  );
}
