import { Fragment } from "react";

/** A path that line-breaks after its slashes: each "/" ends a segment with a
 *  break opportunity, so a wrapped path reads folder by folder. Give the
 *  surrounding element `[overflow-wrap:anywhere]` so a single name longer
 *  than the line still breaks rather than overflowing. */
export function SlashBreaks({ text }: { text: string }) {
  const parts = text.split("/");
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>{part}{index < parts.length - 1 && <>/<wbr /></>}</Fragment>
      ))}
    </>
  );
}
