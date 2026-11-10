import type { ReviewItemPayload } from "@sentry/junior/api/schema";
import { reviewItemSchema } from "@sentry/junior/api/schema";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useToastManager } from "../components/ui/toast";
import { post } from "../http";
import { REVIEW_ITEMS_QUERY_KEY } from "./queries";

const UNDO_MS = 6_000;

/** Close swept items, then refresh the inbox. */
function commitSweep(queryClient: QueryClient, items: ReviewItemPayload[]) {
  return Promise.allSettled(
    items.map((item) =>
      post(
        reviewItemSchema,
        `/api/review-items/${encodeURIComponent(item.id)}/actions`,
        { action: "dismiss" },
      ),
    ),
  ).then(() =>
    queryClient.invalidateQueries({ queryKey: REVIEW_ITEMS_QUERY_KEY }),
  );
}

/**
 * Sweep inbox items with an Undo. The items hide at once, and close only
 * when the Undo window ends, so Undo needs no reopen on the server. Leaving
 * the inbox ends the window early.
 */
export function useInboxSweep() {
  const queryClient = useQueryClient();
  const { add, close } = useToastManager();
  const [swept, setSwept] = useState<ReadonlySet<string>>(() => new Set());
  const pending = useRef(
    new Map<string, { items: ReviewItemPayload[]; timer: number }>(),
  );

  useEffect(() => {
    const open = pending.current;
    return () => {
      for (const { items, timer } of open.values()) {
        window.clearTimeout(timer);
        void commitSweep(queryClient, items);
      }
      open.clear();
    };
    // The cleanup runs once, when the inbox unmounts.
  }, [queryClient]);

  const sweep = (items: ReviewItemPayload[], stay: number) => {
    if (items.length === 0) return;
    const id = `inbox-sweep-${items[0]!.id}-${items.length}`;
    const ids = items.map((item) => item.id);
    setSwept((current) => new Set([...current, ...ids]));
    const timer = window.setTimeout(() => {
      pending.current.delete(id);
      void commitSweep(queryClient, items);
    }, UNDO_MS);
    pending.current.set(id, { items, timer });
    const undo = () => {
      const entry = pending.current.get(id);
      if (entry) window.clearTimeout(entry.timer);
      pending.current.delete(id);
      setSwept((current) => {
        const next = new Set(current);
        for (const itemId of ids) next.delete(itemId);
        return next;
      });
      close(id);
    };
    add({
      actionProps: { children: "Undo", onClick: undo },
      description:
        stay > 0
          ? `${stay} that need${stay === 1 ? "s" : ""} you stay${stay === 1 ? "s" : ""}.`
          : undefined,
      id,
      timeout: UNDO_MS,
      title: `Cleared ${items.length} item${items.length === 1 ? "" : "s"}`,
      type: "success",
    });
  };

  return { isSwept: (id: string) => swept.has(id), sweep };
}
