import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { describe, expect, it } from "vitest";

import { projectSidebarAnnotationBadges } from "../src/client/conversations/sidebarAnnotationBadges";

type SidebarAnnotation = NonNullable<
  ConversationDetailReport["sidebarAnnotations"]
>[number];

function annotation(
  key: string,
  label: string,
  icon: NonNullable<SidebarAnnotation["icon"]>,
): SidebarAnnotation {
  return { icon, key, label };
}

describe("sidebar annotation badge projection", () => {
  it("groups all status icons by label and bounds labeled groups", () => {
    const projection = projectSidebarAnnotationBadges([
      annotation("a#1", "alpha", "circle-dot"),
      annotation("a#2", "alpha", "git-merge"),
      annotation("b#1", "beta", "circle-dashed"),
      annotation("c#1", "gamma", "git-pull-request"),
    ]);

    expect(
      projection.groups.map((group) => ({
        keys: group.annotations.map((item) => item.key),
        label: group.label,
      })),
    ).toEqual([
      { keys: ["a#1", "a#2"], label: "alpha" },
      { keys: ["b#1"], label: "beta" },
      { keys: ["c#1"], label: "gamma" },
    ]);
    expect(projection.labeledGroups.map((group) => group.label)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(projection.overflowGroupCount).toBe(1);
  });
});
