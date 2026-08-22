import type { ConversationDetailReport } from "@sentry/junior/api/schema";

export type SidebarAnnotation = NonNullable<
  ConversationDetailReport["sidebarAnnotations"]
>[number];

export type SidebarAnnotationBadgeGroup = {
  label: string;
  annotations: SidebarAnnotation[];
};

/** Labeled groups shown before the row collapses into overflow. */
export const MAX_LABELED_SIDEBAR_ANNOTATION_GROUPS = 2;

export type SidebarAnnotationBadgeProjection = {
  /** Every label group in newest-first order. */
  groups: SidebarAnnotationBadgeGroup[];
  /**
   * Fully labeled groups for the compact row.
   * Empty when the row uses the overflow layout.
   */
  labeledGroups: SidebarAnnotationBadgeGroup[];
  /**
   * Leading group kept fully labeled when more than
   * `MAX_LABELED_SIDEBAR_ANNOTATION_GROUPS` groups are present.
   */
  primaryGroup: SidebarAnnotationBadgeGroup | null;
  /**
   * Remaining annotations after the primary group, newest-first.
   * Shown as icon chips before the +N unit count.
   */
  overflowAnnotations: SidebarAnnotation[];
  /** Remaining label groups collapsed behind +N. */
  overflowGroupCount: number;
};

/**
 * Group sidebar annotations by shared label and keep every status icon.
 * Label order follows first appearance (newest-first input).
 */
export function groupSidebarAnnotationsByLabel(
  annotations: SidebarAnnotation[],
): SidebarAnnotationBadgeGroup[] {
  const groups = new Map<string, SidebarAnnotation[]>();
  const order: string[] = [];
  for (const annotation of annotations) {
    const current = groups.get(annotation.label);
    if (!current) {
      groups.set(annotation.label, [annotation]);
      order.push(annotation.label);
      continue;
    }
    current.push(annotation);
  }
  return order.map((label) => ({
    label,
    annotations: groups.get(label) ?? [],
  }));
}

/**
 * Project sidebar annotations into labeled badge groups with overflow.
 * Keeps every work item icon; only the shared label collapses per group.
 */
export function projectSidebarAnnotationBadges(
  annotations: SidebarAnnotation[],
): SidebarAnnotationBadgeProjection {
  const groups = groupSidebarAnnotationsByLabel(annotations);
  if (groups.length <= MAX_LABELED_SIDEBAR_ANNOTATION_GROUPS) {
    return {
      groups,
      labeledGroups: groups,
      primaryGroup: null,
      overflowAnnotations: [],
      overflowGroupCount: 0,
    };
  }

  const [primaryGroup, ...overflowGroups] = groups;
  return {
    groups,
    labeledGroups: [],
    primaryGroup: primaryGroup ?? null,
    overflowAnnotations: overflowGroups.flatMap(
      (group) => group.annotations,
    ),
    overflowGroupCount: overflowGroups.length,
  };
}
