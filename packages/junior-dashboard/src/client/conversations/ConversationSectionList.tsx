import { useCallback, useMemo, type ReactNode } from "react";
import { ArrowUp } from "lucide-react";

import {
  useWaitingConversationsSettled,
  type WaitingConversation,
} from "../review-desk/queries";
import type { Conversation } from "../types";
import {
  buildConversationSections,
  type ConversationSection,
} from "./conversationSections";
import { useHeldListOrder } from "./heldListOrder";
import { PinnedConversationOrder } from "./PinnedConversationOrder";
import type { ReorderPins } from "./useReorderPinnedConversations";

/**
 * Lay out a conversation list in its sections and hold the order while the
 * reader points at it or works in it. The sidebar and the home list render
 * their rows inside this, so both group, sort, and hold the same way. Row
 * actions call `releaseHold`, so their result shows at once.
 */
export function ConversationSectionList(props: {
  children(view: {
    releaseHold(): void;
    sections: ConversationSection[];
  }): ReactNode;
  className?: string;
  conversations: Conversation[];
  loading: boolean;
  onReorderError(conversation: Conversation): void;
  /** Leave unset when the list shows only some pins. */
  onReorderPins?: ReorderPins | undefined;
  timeZone: string;
  waitingConversations: ReadonlyMap<string, WaitingConversation>;
}) {
  // Rebuild sections only when their inputs change. Avoid fresh Date.now()
  // arrays on unrelated parent renders while the reader is scrolling.
  const latestSections = useMemo(
    () =>
      buildConversationSections(props.conversations, {
        nowMs: Date.now(),
        timeZone: props.timeZone,
        waiting: props.waitingConversations,
      }),
    [props.conversations, props.timeZone, props.waitingConversations],
  );
  const waitingSettled = useWaitingConversationsSettled();
  const held = useHeldListOrder(latestSections, {
    settled: !props.loading && waitingSettled,
  });
  const { releaseHold } = held;
  const { onReorderPins } = props;
  const reorderPins = useCallback<ReorderPins>(
    (move) => {
      releaseHold();
      onReorderPins?.(move);
    },
    [onReorderPins, releaseHold],
  );
  const pinned =
    held.sections.find((section) => section.key === "pinned")?.conversations ??
    [];
  return (
    <div {...held.holdProps} className={props.className}>
      <ListUpdatesPill count={held.pending} onApply={held.applyPending} />
      <PinnedConversationOrder
        conversations={pinned}
        onError={props.onReorderError}
        reorder={onReorderPins ? reorderPins : undefined}
      >
        {props.children({ releaseHold, sections: held.sections })}
      </PinnedConversationOrder>
    </div>
  );
}

/**
 * Offer the order that the held list keeps back. The list holds its order
 * while the reader points at it or works in it; this applies the new order.
 */
function ListUpdatesPill(props: { count: number; onApply(): void }) {
  return (
    <div
      aria-live="polite"
      // Above the sticky section headings of the home list.
      className="pointer-events-none sticky top-0 z-20 flex h-0 items-start justify-center"
    >
      {props.count > 0 ? (
        <button
          className="pointer-events-auto mt-1 inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashboard-border-strong bg-dashboard-surface-raised px-2.5 py-1 font-sans text-xs font-medium text-dashboard-text shadow-sm duration-150 hover:border-dashboard-border-interactive focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
          onClick={props.onApply}
          type="button"
        >
          <ArrowUp aria-hidden="true" className="size-3" />
          {props.count} updated
        </button>
      ) : null}
    </div>
  );
}
