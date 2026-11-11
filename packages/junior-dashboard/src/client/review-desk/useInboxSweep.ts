import type { ReviewItemPayload } from "@sentry/junior/api/schema";
import { reviewItemSchema } from "@sentry/junior/api/schema";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useToastManager } from "../components/ui/toast";
import { post } from "../http";
import { REVIEW_ITEMS_QUERY_KEY } from "./queries";

const UNDO_MS = 6_000;

/** Close swept items, refresh the inbox, and return the ids that stay open. */
async function commitSweep(
  queryClient: QueryClient,
  items: ReviewItemPayload[],
): Promise<string[]> {
  const results = await Promise.allSettled(
    items.map((item) =>
      post(
        reviewItemSchema,
        `/api/review-items/${encodeURIComponent(item.id)}/actions`,
        { action: "dismiss" },
      ),
    ),
  );
  await queryClient.invalidateQueries({ queryKey: REVIEW_ITEMS_QUERY_KEY });
  return items
    .filter((_, index) => results[index]!.status === "rejected")
    .map((item) => item.id);
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
  // Each sweep gets its own toast and timer, so Undo cancels only its own.
  const sweeps = useRef(0);

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

  const unsweep = (ids: readonly string[]) =>
    setSwept((current) => {
      const next = new Set(current);
      for (const itemId of ids) next.delete(itemId);
      return next;
    });

  const sweep = (items: ReviewItemPayload[]) => {
    if (items.length === 0) return;
    sweeps.current += 1;
    const id = `inbox-sweep-${sweeps.current}`;
    const ids = items.map((item) => item.id);
    setSwept((current) => new Set([...current, ...ids]));
    const timer = window.setTimeout(() => {
      pending.current.delete(id);
      // Items that did not close come back, so the inbox shows what is
      // still open on the server.
      void commitSweep(queryClient, items).then((failed) => {
        if (failed.length === 0) return;
        unsweep(failed);
        add({
          title: `Could not clear ${failed.length} item${failed.length === 1 ? "" : "s"}`,
          type: "error",
        });
      });
    }, UNDO_MS);
    pending.current.set(id, { items, timer });
    const undo = () => {
      const entry = pending.current.get(id);
      if (entry) window.clearTimeout(entry.timer);
      pending.current.delete(id);
      unsweep(ids);
      close(id);
    };
    add({
      actionProps: { children: "Undo", onClick: undo },
      description: "Questions and approvals stay.",
      id,
      timeout: UNDO_MS,
      title: `Cleared ${items.length} item${items.length === 1 ? "" : "s"}`,
      type: "success",
    });
  };

  return { isSwept: (id: string) => swept.has(id), sweep };
}
