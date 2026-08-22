import type { ConversationDetailReport } from "@sentry/junior/api/schema";

export type SidebarAnnotation = NonNullable<
  ConversationDetailReport["sidebarAnnotations"]
>[number];

export type SidebarAnnotationBadgeGroup = {
  label: string;
  annotations: SidebarAnnotation[];
};

/** Labeled groups shown before the row collapses into +N. */
export const MAX_LABELED_SIDEBAR_ANNOTATION_GROUPS = 2;

export type SidebarAnnotationBadgeProjection = {
  /** Every label group in newest-first order. */
  groups: SidebarAnnotationBadgeGroup[];
  /** Up to `MAX_LABELED_SIDEBAR_ANNOTATION_GROUPS` fully labeled groups. */
  labeledGroups: SidebarAnnotationBadgeGroup[];
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
 * Project sidebar annotations into labeled badge groups with plain +N overflow.
 * Desktop keeps spaced icons inside each label chip. Mobile facepile is a
 * separate render path when more than one label is present.
 */
export function projectSidebarAnnotationBadges(
  annotations: SidebarAnnotation[],
): SidebarAnnotationBadgeProjection {
  const groups = groupSidebarAnnotationsByLabel(annotations);
  return {
    groups,
    labeledGroups: groups.slice(0, MAX_LABELED_SIDEBAR_ANNOTATION_GROUPS),
    overflowGroupCount: Math.max(
      0,
      groups.length - MAX_LABELED_SIDEBAR_ANNOTATION_GROUPS,
    ),
  };
}
