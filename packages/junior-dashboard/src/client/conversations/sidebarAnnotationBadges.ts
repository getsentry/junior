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

/** Group annotations by shared label and keep every status icon. */
function groupSidebarAnnotationsByLabel(
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

/** Project annotations into newest-first label groups with bounded labels. */
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
