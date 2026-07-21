import { useMemo } from "react";
import { NavLink } from "react-router";
import { useProjectsStore } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import { selectAttentionFeatures } from "@/lib/attention";
import { featureHref } from "@/lib/feature-href";
import { cn } from "@/lib/utils";

type DotKey = "input" | "review" | "idle";

const DOT_BG: Record<DotKey, string> = {
  input: "bg-status-input",
  review: "bg-status-review",
  idle: "bg-faint"
};

export function FeaturesNavSection({
  onNavigate,
  className
}: {
  onNavigate?: () => void;
  /** The shells pass `flex-1 min-h-0` so this section is the only thing that
   *  absorbs the nav's spare height. Everything else in the nav has a fixed
   *  identity and must not move when the feature list grows or the Needs you
   *  band appears. */
  className?: string;
}) {
  const projects = useProjectsStore((s) => s.projects);
  const items = useWorkItemsStore((s) => s.items);

  const attention = useMemo(
    () => selectAttentionFeatures(projects, items.values()),
    [projects, items]
  );

  // One map for every row, derived from a stable store reference. Building this
  // inside the selector would return a fresh Map per call and re-render on
  // every publish.
  const urgencyByFeatureId = useMemo(() => {
    const map = new Map<string, DotKey>();
    for (const item of items.values()) map.set(item.featureId, item.needsUser ?? "idle");
    return map;
  }, [items]);

  // Groups keep the store's order, untouched. That order is the user's own —
  // projects come back `order by sort_order asc` and the projects page lets him
  // drag them into it, persisted server-side — so sorting by name here would
  // make drag-to-reorder a dead feature everywhere except the page where it is
  // performed.
  //
  // The current project used to float to the top. It does not any more: this
  // list exists to be scanned, and floating rearranged every group the moment
  // you clicked a feature — the row you just chose moved, and every other group
  // moved with it. Positional memory is worth more here than proximity, which
  // is the same reason nothing variable sits above the nav's destinations.
  const groups = useMemo(() => {
    return projects
      // A project whose features are all archived would otherwise render a
      // heading and a rule line over nothing.
      .filter((project) => project.features.length > 0)
      .map((project) => ({
        project,
        features: [...project.features].sort((a, b) => {
          const aPinned = a.pinnedAt !== null;
          const bPinned = b.pinnedAt !== null;
          if (aPinned !== bPinned) return aPinned ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
      }));
  }, [projects]);

  const totalFeatures = projects.reduce((n, p) => n + p.features.length, 0);

  return (
    <div className={cn("flex flex-col min-h-0", className)}>
      {/* An empty band is not rendered at all, header included. A standing
          "all clear" row would buy layout stability with a permanent line that
          says nothing; the list shifting when something starts wanting you is
          exactly the moment to look. */}
      {attention.length > 0 && (
        <>
          <SectionHead label="Needs you" count={attention.length} />
          {/* SectionHead is aria-hidden, so the band's name has to live on the
              band — the house pattern in Sidebar/MobileNav. Without it a
              flagged feature, which appears in BOTH bands, is heard twice with
              nothing to tell the two lists apart. */}
          <div role="group" aria-label="Needs you" data-band="needs" className="flex flex-col gap-0.5">
            {attention.map((row) => (
              <FeatureLink
                key={row.featureId}
                href={row.href}
                name={row.featureName}
                project={row.projectName}
                urgency={row.needsUser}
                wants
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </>
      )}

      <SectionHead label="All features" count={totalFeatures} />
      <div
        role="group"
        aria-label="All features"
        data-band="all"
        className="flex flex-col gap-0.5 min-h-0 overflow-y-auto"
      >
        {groups.map(({ project, features }) => (
          <div key={project.id} className="flex flex-col gap-0.5">
            <div
              data-project-group={project.name}
              className="flex items-center gap-2 px-3 pt-3 pb-1 text-xs text-chrome select-none"
            >
              <span className="truncate">{project.name}</span>
            </div>
            {features.map((feature) => (
              <FeatureLink
                key={feature.id}
                href={featureHref(project.tmuxSessionName, feature.tmuxWindowName)}
                name={feature.name}
                urgency={urgencyByFeatureId.get(feature.id) ?? "idle"}
                pinned={feature.pinnedAt !== null}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionHead({ label, count }: { label: string; count: number }) {
  return (
    // Not `label-micro`. That is 12px UPPERCASE at 0.08em tracking in a dim
    // tone — a data-table column-header vocabulary, and it is most of why this
    // column reads as a different product from the nav sidebars it sits beside.
    // Sentence case at body size, bold and bright: the rank comes from weight,
    // not from dimming. Only the count stays quiet.
    <div
      aria-hidden
      data-band-head={label}
      className="flex items-center px-3 pt-5 pb-1.5 text-sm font-semibold text-foreground select-none"
    >
      <span>{label}</span>
      <span className="ml-auto num text-2xs font-normal text-chrome">{count}</span>
    </div>
  );
}

interface FeatureLinkProps {
  href: string;
  name: string;
  project?: string;
  urgency: DotKey;
  /** Band 1 rows carry the frame: a frame means this one wants you. */
  wants?: boolean;
  pinned?: boolean;
  onNavigate?: () => void;
}

/** NavLink, not Link, and deliberately without `end`.
 *
 *  `[&.active]:` only fires on a class something actually applies. A plain
 *  `Link` never applies one — NavItemRow gets away with the same idiom because
 *  it passes `active && "active"` itself. NavLink appends `active` to a string
 *  className, and sets aria-current="page", which is what the tree this
 *  replaces did by hand.
 *
 *  Without `end`, matching is prefix-by-segment, so a feature row stays active
 *  on its /pane/:paneId sub-route — the same span the tree spelled out as
 *  `pathname === url || pathname.startsWith(url + "/")`. Adding `end` would
 *  drop the row's highlight the moment you open one of its panes. */
function FeatureLink({ href, name, project, urgency, wants, pinned, onNavigate }: FeatureLinkProps) {
  return (
    <NavLink
      to={href}
      data-feature-name={name}
      title={project ? `${name} — ${project}` : name}
      onClick={() => onNavigate?.()}
      className={cn(
        "flex items-center gap-2.5 h-8 rounded-md px-3 text-sm min-w-0 transition-colors",
        "text-foreground/90 hover:text-foreground hover:bg-foreground/5",
        "[&.active]:text-foreground [&.active]:bg-foreground/[0.06]",
        wants && "border border-border bg-foreground/[0.03]"
      )}
    >
      {/* Named, not aria-hidden: the dot is the only thing on the row carrying
          urgency, so hiding it makes urgency colour-only — unreadable to a
          screen reader and to anyone who cannot separate the two hues. The
          tree this replaces labelled it; `role="img"` is what actually gets
          the label exposed, since a bare span is a generic with no name. */}
      <span
        role="img"
        aria-label={`urgency: ${urgency}`}
        className={cn("h-2 w-2 rounded-full shrink-0", DOT_BG[urgency])}
      />
      <span className="truncate min-w-0">
        {pinned && <span className="text-status-review mr-1">★</span>}
        {name}
      </span>
      {project && <span className="ml-auto pl-2 shrink-0 text-2xs text-chrome">{project}</span>}
    </NavLink>
  );
}
