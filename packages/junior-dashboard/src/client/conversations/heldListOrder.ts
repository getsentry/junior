import {
  useCallback,
  useEffect,
  useState,
  type FocusEvent,
  type PointerEvent,
} from "react";

import type { ConversationSection } from "./conversationSections";

/** The row order of a list at one moment: section keys and labels, row ids. */
export type HeldOrder = { ids: string[]; key: string; label: string }[];

/** Read the row order that a list shows now. */
export function sectionOrder(sections: ConversationSection[]): HeldOrder {
  return sections.map((section) => ({
    ids: section.conversations.map((conversation) => conversation.id),
    key: section.key,
    label: section.label,
  }));
}

/**
 * Show the latest conversations in a held row order. A row keeps its held
 * section and place but shows its latest data. A row that is gone drops out.
 * `pending` counts the rows that the latest order would add or move: a new
 * row, a row in another section, or a row out of order in its section.
 */
export function holdSectionOrder(
  held: HeldOrder,
  latest: ConversationSection[],
): { pending: number; sections: ConversationSection[] } {
  const byId = new Map(
    latest.flatMap((section) =>
      section.conversations.map(
        (conversation) => [conversation.id, conversation] as const,
      ),
    ),
  );
  const shown = new Map<string, { index: number; key: string }>();
  const sections = held.flatMap((section) => {
    const conversations = section.ids.flatMap((id) => byId.get(id) ?? []);
    conversations.forEach((conversation, index) =>
      shown.set(conversation.id, { index, key: section.key }),
    );
    return conversations.length > 0
      ? [{ conversations, key: section.key, label: section.label }]
      : [];
  });
  let pending = 0;
  for (const section of latest) {
    const kept = section.conversations.flatMap((conversation) => {
      const place = shown.get(conversation.id);
      return place?.key === section.key ? [place.index] : [];
    });
    pending += section.conversations.length - longestIncreasingRun(kept);
  }
  return { pending, sections };
}

/** Length of the longest increasing subsequence: the rows that need no move. */
function longestIncreasingRun(values: number[]): number {
  const tails: number[] = [];
  for (const value of values) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle]! < value) low = middle + 1;
      else high = middle;
    }
    tails[low] = value;
  }
  return tails.length;
}

type Hold = { following: boolean; order: HeldOrder };

/**
 * Hold a list's row order while the pointer is over it or focus is in it, so
 * a row does not move under the reader's pointer. The hold starts only once
 * the list is `settled`, so a pointer that rests on the list during a page
 * load does not hold back the first rows. New activity waits as
 * `pending` until the reader calls `applyPending`, or the pointer and focus
 * leave. React events bubble through portals, so a row menu counts as in
 * the list. `releaseHold` follows the latest order until the hold ends; row
 * actions such as pin, archive, and mark unread call it, so their result
 * shows at once.
 */
export function useHeldListOrder(
  sections: ConversationSection[],
  options: {
    /** False until the reads that place rows finish, so they can settle. */
    settled: boolean;
  },
) {
  const [hold, setHold] = useState<Hold | null>(null);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const holding = options.settled && (pointerInside || focusInside);
  // Start and end the hold during render, from the inputs that set it, so the
  // first held render already shows the held order.
  if (holding && !hold) {
    setHold({ following: false, order: sectionOrder(sections) });
  }
  if (!holding && hold) setHold(null);

  const view =
    hold && !hold.following
      ? holdSectionOrder(hold.order, sections)
      : { pending: 0, sections };

  // A focused pill that unmounts sends no blur, and focus falls to the body.
  useEffect(() => {
    if (focusInside && document.activeElement === document.body) {
      setFocusInside(false);
    }
  }, [focusInside, view.pending]);

  const applyPending = useCallback(
    () =>
      setHold((current) =>
        current ? { following: false, order: sectionOrder(sections) } : current,
      ),
    [sections],
  );
  const releaseHold = useCallback(
    () =>
      setHold((current) =>
        current ? { following: true, order: current.order } : current,
      ),
    [],
  );
  const holdProps = {
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        setFocusInside(false);
      }
    },
    onFocus: () => setFocusInside(true),
    // Touch has no hover, so only a mouse or pen holds the order.
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch") setPointerInside(true);
    },
    onPointerLeave: () => setPointerInside(false),
  };
  return {
    applyPending,
    holdProps,
    pending: view.pending,
    releaseHold,
    sections: view.sections,
  };
}
