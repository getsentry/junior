import { useQueryClient } from "@tanstack/react-query";
import {
  inboxSnoozeSchema,
  type InboxSnoozeCreateBody,
} from "@sentry/junior/api/schema";
import { useState } from "react";

import { useToastManager } from "../components/ui/toast";
import { deleteDashboardResource, post } from "../http";
import { invalidateReviewItemCollections } from "./queries";
import type { InboxBundle } from "./reviewItemFormat";
import type { SnoozeChoice } from "./snoozeChoices";

const SNOOZES_PATH = "/api/inbox/snoozes";

/** What the Snoozed list says about the viewer's snoozed rows. */
interface SnoozedRead {
  /** Some page of Snoozed could not be read. */
  failed: boolean;
  /** The open items of the snoozed rows, once every page is read. */
  itemIds?: ReadonlySet<string>;
  /** When the Inbox list last read the server, as `Date.now()`. */
  listUpdatedAtMs: number;
}

/**
 * Snooze Inbox rows on the server, so a snooze holds in every browser. A
 * row wakes at its time, or when its Conversation adds an item; the
 * versions poll then refreshes the lists. The server hides snoozed rows
 * from the Inbox lists and counts; until the Inbox list reads the server
 * again, `hides` keeps a row that was just snoozed out of the lists, and
 * `waking` one that was just woken.
 */
export function useInboxSnoozes(read: SnoozedRead) {
  const queryClient = useQueryClient();
  const toast = useToastManager();
  // When each just-snoozed Conversation's snooze saved; Infinity while it
  // saves. A list read after that time already leaves the row out.
  const [hidden, setHidden] = useState<ReadonlyMap<string, number>>(new Map());
  const [waking, setWaking] = useState<ReadonlySet<string>>(new Set());
  const hide = (conversationId: string, savedAtMs: number | undefined) =>
    setHidden((current) => {
      const next = new Map(current);
      if (savedAtMs === undefined) next.delete(conversationId);
      else next.set(conversationId, savedAtMs);
      return next;
    });
  const snooze = async (bundle: InboxBundle, choice: SnoozeChoice) => {
    hide(bundle.conversationId, Infinity);
    try {
      const body: InboxSnoozeCreateBody = {
        conversationId: bundle.conversationId,
        wakeAt: new Date(choice.untilMs(Date.now())).toISOString(),
      };
      await post(inboxSnoozeSchema, SNOOZES_PATH, body);
    } catch {
      // The row leaves while the snooze saves, so a failure brings it back.
      hide(bundle.conversationId, undefined);
      toast.add({ title: "The row could not be snoozed", type: "error" });
      return;
    }
    hide(bundle.conversationId, Date.now());
    await invalidateReviewItemCollections(queryClient);
  };
  /** Wake a snoozed row now: undo the viewer's snoozes on its Conversation. */
  const wake = async (bundle: InboxBundle) => {
    setWaking((current) => new Set(current).add(bundle.key));
    try {
      await deleteDashboardResource(SNOOZES_PATH, {
        conversationId: bundle.conversationId,
      });
      await invalidateReviewItemCollections(queryClient);
    } finally {
      setWaking((current) => {
        const next = new Set(current);
        next.delete(bundle.key);
        return next;
      });
    }
  };
  return {
    /**
     * The Conversation was just snoozed, and the lists have not refreshed
     * yet. A snooze hides every row of its Conversation.
     */
    hides: (conversationId: string) =>
      (hidden.get(conversationId) ?? -Infinity) >= read.listUpdatedAtMs,
    /**
     * A snooze hides this item from the viewer. Undefined while that is
     * unknown: until Snoozed reads every page, or when a read fails.
     */
    hidesItem: (itemId: string): boolean | undefined =>
      read.failed || !read.itemIds ? undefined : read.itemIds.has(itemId),
    /** Snoozed could not be read, so `hidesItem` stays unknown. */
    failed: read.failed,
    snooze,
    wake,
    /** The row was just woken, and the lists have not refreshed yet. */
    waking: (key: string) => waking.has(key),
  };
}
