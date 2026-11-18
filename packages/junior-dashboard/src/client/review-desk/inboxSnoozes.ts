import { useQueryClient } from "@tanstack/react-query";
import {
  inboxSnoozeSchema,
  type InboxSnoozeCreateBody,
  type ReviewItemPayload,
} from "@sentry/junior/api/schema";
import { useState } from "react";

import { useToastManager } from "../components/ui/toast";
import { deleteDashboardResource, post } from "../http";
import { invalidateReviewItemCollections } from "./queries";
import type { InboxBundle } from "./reviewItemFormat";

const SNOOZES_PATH = "/api/inbox/snoozes";

/** What the Snoozed list says about the viewer's snoozed rows. */
interface SnoozedRead {
  /** Some page of Snoozed could not be read. */
  failed: boolean;
  /** The open items of the snoozed rows, once every page is read. */
  itemIds?: ReadonlySet<string>;
  /** When Snoozed last read the server, as `Date.now()`. */
  itemsUpdatedAtMs: number;
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
  // When the lists refetched after each just-snoozed row's snooze saved, by
  // row key; Infinity until then. A list read after that time already
  // leaves the row out. A read that started before the save does not count:
  // the refetch cancels it.
  const [hidden, setHidden] = useState<ReadonlyMap<string, number>>(new Map());
  const [waking, setWaking] = useState<ReadonlySet<string>>(new Set());
  // When the lists refetched after the viewer's last snooze change;
  // Infinity until then. Snoozed read before that time may be stale.
  const [changedAtMs, setChangedAtMs] = useState(-Infinity);
  const hide = (key: string, savedAtMs: number | undefined) =>
    setHidden((current) => {
      const next = new Map(current);
      if (savedAtMs === undefined) next.delete(key);
      else next.set(key, savedAtMs);
      return next;
    });
  const hiddenNow = (key: string) =>
    (hidden.get(key) ?? -Infinity) >= read.listUpdatedAtMs;
  /**
   * Snooze a row until `untilMs`. A Conversation row snoozes its
   * Conversation; a row of one item, such as an FYI notice, only that item.
   */
  const snooze = async (bundle: InboxBundle, untilMs: number) => {
    const lastChangedAtMs = changedAtMs;
    hide(bundle.key, Infinity);
    setChangedAtMs(Infinity);
    try {
      const body: InboxSnoozeCreateBody = {
        conversationId: bundle.conversationId,
        ...(bundle.key === bundle.conversationId
          ? undefined
          : { reviewItemId: bundle.key }),
        wakeAt: new Date(untilMs).toISOString(),
      };
      await post(inboxSnoozeSchema, SNOOZES_PATH, body);
    } catch {
      // The row leaves while the snooze saves, so a failure brings it back.
      hide(bundle.key, undefined);
      setChangedAtMs(lastChangedAtMs);
      toast.add({ title: "The row could not be snoozed", type: "error" });
      return;
    }
    // The refetch cancels reads in flight, so only reads that start after
    // the save can show the row again.
    await invalidateReviewItemCollections(queryClient);
    hide(bundle.key, Date.now());
    setChangedAtMs(Date.now());
  };
  /** Wake a snoozed row now: undo the viewer's snoozes on its Conversation. */
  const wake = async (bundle: InboxBundle) => {
    const lastChangedAtMs = changedAtMs;
    setWaking((current) => new Set(current).add(bundle.key));
    setChangedAtMs(Infinity);
    try {
      await deleteDashboardResource(SNOOZES_PATH, {
        conversationId: bundle.conversationId,
      });
      await invalidateReviewItemCollections(queryClient);
      setChangedAtMs(Date.now());
    } catch {
      setChangedAtMs(lastChangedAtMs);
      // The row stays in Snoozed, so say why it did not wake.
      toast.add({ title: "The row could not be woken", type: "error" });
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
     * The item's row was just snoozed, and the lists have not refreshed
     * yet: the item alone, or a Conversation that added or links it. The
     * server also hides items that link a thread of that Conversation;
     * those leave when the lists refresh.
     */
    hides: (item: ReviewItemPayload) =>
      hiddenNow(item.id) ||
      hiddenNow(item.addedByConversationId) ||
      item.conversationIds.some(hiddenNow),
    /**
     * A snooze hides this item from the viewer. Undefined while that is
     * unknown: until Snoozed reads every page after the viewer's last
     * snooze change, or when a read fails.
     */
    hidesItem: (itemId: string): boolean | undefined =>
      read.failed || !read.itemIds || read.itemsUpdatedAtMs <= changedAtMs
        ? undefined
        : read.itemIds.has(itemId),
    /** Snoozed could not be read, so `hidesItem` stays unknown. */
    failed: read.failed,
    snooze,
    wake,
    /** The row was just woken, and the lists have not refreshed yet. */
    waking: (key: string) => waking.has(key),
  };
}
