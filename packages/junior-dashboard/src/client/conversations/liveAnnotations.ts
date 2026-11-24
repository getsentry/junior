import { useMemo } from "react";

import { sameTypeCard, useListedObjects } from "../display-text/DisplayText";
import type { SidebarAnnotation } from "./sidebarAnnotationBadges";

// Linked work whose status changes after Junior links it, such as a pull
// request that merges.
const LIVE_TYPES = new Set(["code_change", "task"]);

/**
 * Show linked work with the status and title of its live card, once the
 * card comes. Until then, and without a card, it keeps what Junior linked.
 * The rows of one `MessageObjectsProvider` that ask together read their
 * cards in one request.
 */
export function useLiveAnnotations<T extends SidebarAnnotation>(
  annotations: T[] | undefined,
): T[] | undefined {
  const listedOf = useListedObjects(
    (annotations ?? []).flatMap((annotation) =>
      annotation.objectType && LIVE_TYPES.has(annotation.objectType)
        ? (annotation.url ?? [])
        : [],
    ),
  );
  return useMemo(
    () =>
      annotations?.map((annotation) => {
        const card =
          annotation.objectType && LIVE_TYPES.has(annotation.objectType)
            ? sameTypeCard(listedOf(annotation.url).card, annotation.objectType)
            : undefined;
        if (!card) return annotation;
        return {
          ...annotation,
          status: card.status ?? annotation.status,
          title: card.title ?? annotation.title,
        };
      }),
    [annotations, listedOf],
  );
}
