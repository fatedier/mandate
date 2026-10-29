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
  const href = source.useHref(mention.id);
  if (!href) return <>@{mention.label}</>;
  return (
    <Link
      to={href}
      data-slot="mention-tag"
      // Inline in the sentence: selected and copied with it, wrapped as its
      // words wrap (the tint carried across), and no touch area grown past
      // its text, which on a phone covered the tag on the line above.
      className="mx-0.5 rounded-md bg-background/55 px-1 py-px text-xs text-foreground box-decoration-clone transition-colors hover:bg-background/80"
    >
      <span className="text-faint">@</span>{mention.label}
    </Link>
  );
}
