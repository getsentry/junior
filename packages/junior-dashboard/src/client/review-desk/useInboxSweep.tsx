import type { ReviewItemPayload } from "@sentry/junior/api/schema";
import { reviewItemSchema } from "@sentry/junior/api/schema";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import pLimit from "p-limit";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useToastManager } from "../components/ui/toast";
import { post } from "../http";
import { fyiCount } from "./inboxModel";
import { invalidateReviewItemCollections, reviewItemQueryKey } from "./queries";

const UNDO_MS = 6_000;
// Dismiss requests that one sweep sends at once.
const SWEEP_REQUESTS = 8;

/** Close swept items, refresh the inbox, and return the ids that stay open. */
async function commitSweep(
  queryClient: QueryClient,
  items: ReviewItemPayload[],
): Promise<string[]> {
  const limit = pLimit(SWEEP_REQUESTS);
  const results = await Promise.allSettled(
    items.map((item) =>
      limit(() =>
        post(
          reviewItemSchema,
          `/api/review-items/${encodeURIComponent(item.id)}/actions`,
          { action: "dismiss" },
        ),
      ),
    ),
  );
  const kept: string[] = [];
  for (const [index, result] of results.entries()) {
    const id = items[index]!.id;
    if (result.status === "fulfilled") {
      queryClient.setQueryData(reviewItemQueryKey(id), result.value);
      continue;
    }
    kept.push(id);
    void queryClient.invalidateQueries({
      exact: true,
      queryKey: reviewItemQueryKey(id),
    });
  }
  await invalidateReviewItemCollections(queryClient);
  return kept;
}

function unsweep(
  setSwept: (
    update: (current: ReadonlySet<string>) => ReadonlySet<string>,
  ) => void,
  ids: readonly string[],
) {
  setSwept((current) => {
    const next = new Set(current);
    for (const itemId of ids) next.delete(itemId);
    return next;
  });
}

type InboxSweeper = {
  isSwept(id: string): boolean;
  sweep(items: ReviewItemPayload[]): void;
};

const InboxSweepContext = createContext<InboxSweeper | null>(null);

type Toasts = Pick<ReturnType<typeof useToastManager>, "add" | "close">;

// The toast manager re-renders its caller on every toast change. This leaf
// takes those renders, so the provider and the Inbox that reads it do not.
function ToastsBridge(props: { onToasts: (toasts: Toasts) => void }) {
  const { add, close } = useToastManager();
  const { onToasts } = props;
  useLayoutEffect(() => {
    onToasts({ add, close });
  }, [add, close, onToasts]);
  return null;
}

/**
 * Own the Inbox's sweeps for the whole dashboard, next to the toasts. The
 * swept items hide at once and close when their toast closes, by timeout
 * or by its close button. So Undo works from any page while the toast
 * shows, and needs no reopen on the server. Leaving the page closes the
 * items that are still pending.
 */
export function InboxSweepProvider(props: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toasts = useRef<Toasts | null>(null);
  const onToasts = useCallback((next: Toasts) => {
    toasts.current = next;
  }, []);
  const [swept, setSwept] = useState<ReadonlySet<string>>(() => new Set());
  // The items of each sweep whose toast still shows, by toast id. Each
  // sweep gets its own toast, so Undo takes back only its own items.
  const pending = useRef(new Map<string, ReviewItemPayload[]>());
  const sweeps = useRef(0);

  useEffect(() => {
    const open = pending.current;
    const flush = () => {
      for (const items of open.values()) void commitSweep(queryClient, items);
      open.clear();
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [queryClient]);

  const sweep = useCallback(
    (items: ReviewItemPayload[]) => {
      const manager = toasts.current;
      if (items.length === 0 || !manager) return;
      const { add, close } = manager;
      sweeps.current += 1;
      const id = `inbox-sweep-${sweeps.current}`;
      const ids = items.map((item) => item.id);
      setSwept((current) => new Set([...current, ...ids]));
      pending.current.set(id, items);
      const commit = () => {
        // Undo or leaving the page already settled this sweep.
        if (!pending.current.delete(id)) return;
        // Items that did not close come back, so the inbox shows what is
        // still open on the server.
        void commitSweep(queryClient, items).then((failed) => {
          if (failed.length === 0) return;
          unsweep(setSwept, failed);
          add({
            title: `Could not dismiss ${fyiCount(failed.length)}`,
            type: "error",
          });
        });
      };
      const undo = () => {
        pending.current.delete(id);
        unsweep(setSwept, ids);
        close(id);
      };
      add({
        actionProps: { children: "Undo", onClick: undo },
        description: "Questions and approvals stay.",
        id,
        onClose: commit,
        timeout: UNDO_MS,
        title: `Dismissed ${fyiCount(items.length)}`,
        type: "success",
      });
    },
    [queryClient],
  );
  const sweeper = useMemo<InboxSweeper>(
    () => ({ isSwept: (id) => swept.has(id), sweep }),
    [swept, sweep],
  );

  return (
    <InboxSweepContext.Provider value={sweeper}>
      <ToastsBridge onToasts={onToasts} />
      {props.children}
    </InboxSweepContext.Provider>
  );
}

/** Dismiss Inbox FYIs with an Undo, through `InboxSweepProvider`. */
export function useInboxSweep(): InboxSweeper {
  const sweeper = useContext(InboxSweepContext);
  if (!sweeper) throw new Error("useInboxSweep needs an InboxSweepProvider");
  return sweeper;
}
