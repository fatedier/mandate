import { describe, expect, test } from "bun:test";
import { countAttention, selectAttentionFeatures } from "@/lib/attention";
import type { Project } from "@/store/projects";
import type { WorkItemDto } from "@shared/api/work-items";

/** Only the fields the count path reaches — plus names, which are not optional
 *  decoration. `selectAttentionFeatures` sorts by `featureName` and then by
 *  `projectName`, so a nameless fixture throws
 *  `TypeError: undefined is not an object (evaluating 'a.featureName.localeCompare')`
 *  the moment two of its rows share an urgency. None of the three countAttention
 *  cases below produces such a pair, which is the only reason the nameless
 *  version of this helper ever worked; the next case added would have hit it. */
function project(id: string, featureIds: string[]): Project {
  return {
    id,
    name: id,
    features: featureIds.map((fid) => ({ id: fid, name: fid }))
  } as unknown as Project;
}

function item(featureId: string, needsUser: "input" | "review" | null): WorkItemDto {
  return { id: `wi-${featureId}`, featureId, needsUser } as unknown as WorkItemDto;
}

describe("countAttention", () => {
  test("counts items flagged input or review on live features", () => {
    const projects = [project("p1", ["f1", "f2"]), project("p2", ["f3"])];
    const items = [item("f1", "input"), item("f2", null), item("f3", "review")];
    expect(countAttention(projects, items)).toBe(2);
  });

  test("ignores flagged items whose feature is not in any live project", () => {
    const projects = [project("p1", ["f1"])];
    const items = [item("f1", null), item("ghost", "input")];
    expect(countAttention(projects, items)).toBe(0);
  });

  test("empty inputs count zero", () => {
    expect(countAttention([], [])).toBe(0);
  });
});

function fullProject(
  id: string,
  name: string,
  slug: string,
  features: Array<{ id: string; name: string; slug: string; pinnedAt?: string | null }>
): Project {
  return {
    id,
    name,
    tmuxSessionName: slug,
    features: features.map((f) => ({
      id: f.id,
      name: f.name,
      tmuxWindowName: f.slug,
      pinnedAt: f.pinnedAt ?? null
    }))
  } as unknown as Project;
}

describe("selectAttentionFeatures", () => {
  test("orders input before review, then by feature name", () => {
    const projects = [
      fullProject("p1", "frp", "md-frp", [
        { id: "f1", name: "alpha", slug: "w-alpha" },
        { id: "f2", name: "beta", slug: "w-beta" },
        { id: "f3", name: "gamma", slug: "w-gamma" }
      ])
    ];
    // The fixture must vary in BOTH asserted dimensions, so it is fed in an
    // order no sub-clause of the comparator can reproduce on its own:
    //   - `gamma` (the only `input` row) is fed last, so a no-op sort would
    //     leave it last instead of first — this is what pins the urgency clause.
    //   - the two `review` rows are fed in REVERSE name order (beta, then
    //     alpha), so the expected alpha-before-beta is reachable only through
    //     the name comparison. Array.prototype.sort is stable, so a comparator
    //     that returned 0 for equal urgency would preserve the feed order and
    //     put beta first.
    const items = [
      item("f2", "review"),
      item("f1", "review"),
      item("f3", "input")
    ];
    const out = selectAttentionFeatures(projects, items);
    expect(out.map((f) => [f.featureName, f.needsUser])).toEqual([
      ["gamma", "input"],
      ["alpha", "review"],
      ["beta", "review"]
    ]);
  });

  test("orders by name across all projects, not within each project", () => {
    const projects = [
      fullProject("p1", "frp", "md-frp", [
        { id: "f-bravo", name: "bravo", slug: "w-bravo" },
        { id: "f-delta", name: "delta", slug: "w-delta" }
      ]),
      fullProject("p2", "mandate", "md-mandate", [
        { id: "f-alpha", name: "alpha", slug: "w-alpha" },
        { id: "f-charlie", name: "charlie", slug: "w-charlie" }
      ])
    ];
    const items = [
      item("f-delta", "review"),
      item("f-alpha", "review"),
      item("f-charlie", "review"),
      item("f-bravo", "review")
    ];
    const out = selectAttentionFeatures(projects, items);
    // The expected order alternates between the two projects. Any
    // implementation that grouped rows by project — emitting or sorting
    // project-by-project rather than over one flat list — keeps each project's
    // rows contiguous, so no such implementation can produce this. The feed
    // order is scrambled, so a no-op sort cannot produce it either.
    expect(out.map((f) => [f.featureName, f.projectName])).toEqual([
      ["alpha", "mandate"],
      ["bravo", "frp"],
      ["charlie", "mandate"],
      ["delta", "frp"]
    ]);
  });

  test("breaks a same-name tie by project name, whatever order items arrive in", () => {
    // A feature name is unique only within its project:
    // `idx_features_active_name` is unique on `(project_id, name)` among
    // unarchived rows, so two live features in different projects may carry the
    // same name. Without the final tiebreak these two rows compare equal, so
    // their order falls through to the feed order of `items` — which for the
    // real caller is work-item Map insertion order, populated
    // newest-activity-first. The list would then reshuffle across reloads.
    const projects = [
      fullProject("p1", "mandate", "md-mandate", [{ id: "f-m", name: "main", slug: "w-main" }]),
      fullProject("p2", "frp", "md-frp", [{ id: "f-f", name: "main", slug: "w-main" }])
    ];
    // Fed mandate-first, against the expected frp-first result, so the
    // expected order is reachable only through the project-name comparison.
    const out = selectAttentionFeatures(projects, [item("f-m", "review"), item("f-f", "review")]);
    expect(out.map((f) => [f.featureName, f.projectName])).toEqual([
      ["main", "frp"],
      ["main", "mandate"]
    ]);
  });

  test("same-name rows land in the same order from either feed order", () => {
    // The property the tiebreak actually buys: the output does not depend on
    // the order `items` iterates in. Asserted separately from the expected
    // order above so a failure says which of the two broke.
    const projects = [
      fullProject("p1", "mandate", "md-mandate", [{ id: "f-m", name: "main", slug: "w-main" }]),
      fullProject("p2", "frp", "md-frp", [{ id: "f-f", name: "main", slug: "w-main" }])
    ];
    const mandateFirst = selectAttentionFeatures(projects, [
      item("f-m", "review"),
      item("f-f", "review")
    ]);
    const frpFirst = selectAttentionFeatures(projects, [
      item("f-f", "review"),
      item("f-m", "review")
    ]);
    expect(mandateFirst).toEqual(frpFirst);
  });

  test("carries the project name and href of each row", () => {
    const projects = [
      fullProject("p1", "frp", "md-frp", [{ id: "f1", name: "prepare-v0.70.1", slug: "w-prep" }]),
      fullProject("p2", "mandate", "md-mandate", [{ id: "f2", name: "main", slug: "w-main" }])
    ];
    const out = selectAttentionFeatures(projects, [item("f2", "input")]);
    // Name and the project it belongs to asserted as one unit: a feature name
    // is unique only within its project (`idx_features_active_name` is unique
    // on `(project_id, name)` among unarchived rows), so the name alone
    // identifies nothing.
    expect(out).toEqual([
      {
        featureId: "f2",
        featureName: "main",
        projectName: "mandate",
        href: "/projects/md-mandate/features/w-main",
        needsUser: "input"
      }
    ]);
  });

  test("excludes items whose feature is in no live project", () => {
    const projects = [fullProject("p1", "frp", "md-frp", [{ id: "f1", name: "a", slug: "w-a" }])];
    const out = selectAttentionFeatures(projects, [item("ghost", "input")]);
    expect(out).toEqual([]);
  });

  test("countAttention equals the selected list length", () => {
    const projects = [
      fullProject("p1", "frp", "md-frp", [
        { id: "f1", name: "a", slug: "w-a" },
        { id: "f2", name: "b", slug: "w-b" }
      ])
    ];
    const items = [item("f1", "input"), item("f2", null), item("ghost", "review")];
    expect(countAttention(projects, items)).toBe(selectAttentionFeatures(projects, items).length);
    expect(countAttention(projects, items)).toBe(1);
  });
});
