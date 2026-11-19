import type { MouseEvent } from "react";
import { Link } from "react-router";
import type { Mention } from "@shared/mentions";
import { mentionSourceOf, type MentionSource } from "./mention-sources";

/** A mention in a sent message: the words as written, as a tag that opens
 *  what they name. A kind this page does not know, or a thing gone since,
 *  stays plain words. */
export function MentionTag({ mention }: { mention: Mention }) {
  const source = mentionSourceOf(mention.kind);
  if (!source) return <>@{mention.label}</>;
  return <SourceTag source={source} mention={mention} />;
}

/** One hook per tag: a tag's kind never changes. */
function SourceTag({ source, mention }: { source: MentionSource; mention: Mention }) {
  const target = source.useTag(mention.id);
  if (!target) return <>@{mention.label}</>;
  const { open } = target;
  // A plain click only opens it in the page; with a modifier key or another
  // button the link is the browser's.
  const onClick = open
    ? (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open();
    }
    : undefined;
  return (
    <Link
      to={target.href}
      onClick={onClick}
      data-slot="mention-tag"
      // Inline in the sentence: selected and copied with it, wrapped as its
      // words wrap (the tint carried across), and no touch area grown past
      // its text, which on a phone covered the tag on the line above.
      className="mx-0.5 rounded-md bg-background/55 px-1 py-px text-xs text-foreground box-decoration-clone transition-colors hover:bg-background/80"
    >
      {target.icon ?? <span className="text-faint">@</span>}{mention.label}
    </Link>
  );
}
