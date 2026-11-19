import type { ReviewItemPayload } from "@sentry/junior/api/schema";
import { useEffect, useEffectEvent, useRef } from "react";

import type { useLeaveCard, useLeaveRow } from "./rowMotion";

/**
 * Hold the open row's items, and put away what closes elsewhere. A card of
 * the open row that closes elsewhere, as when an agent or a Watch closes
 * it, leaves as it does on Dismiss, and the next card of the row takes
 * focus. When every card closes, the row leaves and the next row opens. The
 * data holds the items until then. Other rows leave with the read.
 */
export function useLeaveClosedElsewhere(input: {
  closedElsewhere: readonly ReviewItemPayload[];
  expandedKey: string;
  holdLeaving(items: readonly ReviewItemPayload[], held: boolean): void;
  holdOpenRow(items: readonly ReviewItemPayload[]): void;
  leave: ReturnType<typeof useLeaveRow>;
  leaveCard: ReturnType<typeof useLeaveCard>;
  openItems: readonly ReviewItemPayload[];
  releaseHeld(id: string): void;
}) {
  const { closedElsewhere, expandedKey, holdOpenRow, openItems } = input;
  // Cards that are leaving, so a later read does not start their leave
  // again.
  const leaving = useRef(new Set<string>());
  useEffect(() => holdOpenRow(openItems));
  useEffect(() => () => holdOpenRow([]), [holdOpenRow]);
  const closedKey =
    openItems.length > 0 &&
    openItems.every((item) => closedElsewhere.includes(item))
      ? expandedKey
      : undefined;
  const closedCards = closedKey
    ? []
    : openItems
        .filter(
          (item) =>
            closedElsewhere.includes(item) && !leaving.current.has(item.id),
        )
        .map((item) => item.id);
  // The next row opens at once, so the open row's hold moves to the
  // leaving hold, which keeps the row until its motion ends.
  const leaveClosed = useEffectEvent((key: string) => {
    input.holdLeaving(openItems, true);
    input.leave(key, () => input.holdLeaving(openItems, false));
  });
  // A card leaves, then the list stops holding it, so its shut card never
  // shows again.
  const leaveClosedCards = useEffectEvent(() => {
    for (const id of closedCards) {
      leaving.current.add(id);
      input.leaveCard(expandedKey, id, () => {
        input.releaseHeld(id);
        leaving.current.delete(id);
      });
    }
  });
  useEffect(() => {
    if (closedKey) leaveClosed(closedKey);
  }, [closedKey]);
  const closedCardsKey = closedCards.join(" ");
  useEffect(() => {
    if (closedCardsKey) leaveClosedCards();
  }, [closedCardsKey]);
}
