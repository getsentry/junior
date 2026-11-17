import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  wakeAutomationListSchema,
  wakeAutomationSchema,
  type WakeAutomationCreateBody,
  type WakeAutomationPayload,
} from "@sentry/junior/api/schema";
import { useEffect, useState } from "react";

import { deleteDashboardResource, fetchDashboardJson, post } from "../http";
import {
  invalidateReviewItemCollections,
  REVIEW_ITEMS_QUERY_KEY,
} from "./queries";
import type { InboxBundle } from "./reviewItemFormat";
import type { SnoozeChoice } from "./snoozeChoices";

/**
 * Under the Review item reads, so the versions poll refreshes it when a
 * snooze changes, and a snooze change refreshes the Inbox lists and counts.
 */
const SNOOZES_QUERY_KEY = [...REVIEW_ITEMS_QUERY_KEY, "snoozes"];
/** The longest delay `setTimeout` keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The time a snooze's timer fires, if it has one. */
export function snoozeWakesAtMs(
  snooze: WakeAutomationPayload,
): number | undefined {
  for (const trigger of snooze.triggers) {
    if ("firesAt" in trigger) return Date.parse(trigger.firesAt);
  }
  return undefined;
}

/** The viewer's snoozes that hide an Inbox row now, newest first. */
export function useSnoozesData(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: SNOOZES_QUERY_KEY,
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        wakeAutomationListSchema,
        "/api/automations/snoozes",
        signal,
      ),
    retry: false,
  });
}

/** Refresh what a snooze change moves: the snoozes, the lists and counts. */
function refreshInbox(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: SNOOZES_QUERY_KEY }),
    invalidateReviewItemCollections(queryClient),
  ]);
}

/** Wake snoozed rows now: delete their snoozes, then refresh the Inbox. */
export function useWakeSnoozes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: readonly string[]) => {
      await Promise.all(
        ids.map((id) =>
          deleteDashboardResource(`/api/automations/${encodeURIComponent(id)}`),
        ),
      );
      await refreshInbox(queryClient);
    },
  });
}

/** Refresh the Inbox when the next snooze timer fires, so its row wakes. */
function useRefreshAtNextWake(snoozes: readonly WakeAutomationPayload[]) {
  const queryClient = useQueryClient();
  const nextWakeMs = Math.min(
    ...snoozes.flatMap((snooze) => snoozeWakesAtMs(snooze) ?? []),
  );
  useEffect(() => {
    if (!Number.isFinite(nextWakeMs)) return;
    const timer = setTimeout(
      () => void refreshInbox(queryClient),
      Math.min(MAX_TIMER_MS, Math.max(0, nextWakeMs - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [nextWakeMs, queryClient]);
}

/**
 * Snooze Inbox rows on the server: each snooze is a wake Automation, so it
 * holds in every browser. A row wakes at its time, or when its Conversation
 * adds an item. The server hides snoozed rows from the Inbox lists and
 * counts; until a change refreshes them, `hides` keeps a row that was just
 * snoozed out of the lists, and `waking` one that was just woken.
 */
export function useInboxSnoozes(enabled: boolean) {
  const queryClient = useQueryClient();
  const snoozes = useSnoozesData(enabled).data?.snoozes ?? [];
  useRefreshAtNextWake(snoozes);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [waking, setWaking] = useState<ReadonlySet<string>>(new Set());
  const mark = (set: typeof setHidden, key: string, on: boolean) =>
    set((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const wakeSnoozes = useWakeSnoozes();
  /** The snoozes that hide one of the row's items. */
  const snoozesOf = (bundle: InboxBundle) => {
    const ids = new Set(bundle.items.map((item) => item.id));
    return snoozes.filter((snooze) => snooze.itemIds.some((id) => ids.has(id)));
  };
  const snooze = async (bundle: InboxBundle, choice: SnoozeChoice) => {
    mark(setHidden, bundle.key, true);
    try {
      const body: WakeAutomationCreateBody = {
        action: "wake",
        subject: { conversationId: bundle.conversationId },
        triggers: [
          { kind: "new_item" },
          {
            kind: "event",
            namespace: "junior",
            resourceType: "timer",
            events: ["timer.fired"],
            firesAt: new Date(choice.untilMs(Date.now())).toISOString(),
          },
        ],
      };
      await post(wakeAutomationSchema, "/api/automations", body);
      await refreshInbox(queryClient);
    } finally {
      mark(setHidden, bundle.key, false);
    }
  };
  const wake = async (bundle: InboxBundle) => {
    mark(setWaking, bundle.key, true);
    try {
      await wakeSnoozes.mutateAsync(
        snoozesOf(bundle).map((snooze) => snooze.id),
      );
    } finally {
      mark(setWaking, bundle.key, false);
    }
  };
  return {
    /** The row was just snoozed, and the lists have not refreshed yet. */
    hides: (key: string) => hidden.has(key),
    snooze,
    wake,
    /** The row was just woken, and the lists have not refreshed yet. */
    waking: (key: string) => waking.has(key),
  };
}
