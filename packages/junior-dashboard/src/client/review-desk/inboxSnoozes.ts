import { useQueryClient } from "@tanstack/react-query";
import {
  inboxSnoozeSchema,
  type InboxSnoozeCreateBody,
  type InboxSnoozeSubjectBody,
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
 * Snooze Inbox items on the server, so a snooze holds in every browser. A
 * row snoozes its item, and a stack's Snooze all its root's items. An item
 * wakes at its time, or when its root Conversation adds an item; the
 * versions poll then refreshes the lists. The server hides snoozed rows
 * from the Inbox lists and counts; until the Inbox list reads the server
 * again, `hides` keeps a row that was just snoozed out of the lists, and
 * `waking` one that was just woken.
 */
export function useInboxSnoozes(read: SnoozedRead) {
  const queryClient = useQueryClient();
  const toast = useToastManager();
  // When each just-snoozed row's snooze saved, by row key; Infinity until
  // the lists refetch after it. A list read after that time already leaves
  // the row out: the refetch cancels reads that started before the save.
  const [hidden, setHidden] = useState<ReadonlyMap<string, number>>(new Map());
  // The items that were just woken, by id.
  const [waking, setWaking] = useState<ReadonlySet<string>>(new Set());
  // When the viewer's last snooze change saved; Infinity until the lists
  // refetch after it. Snoozed read before that time may be stale.
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
  /** Save a snooze of `subject`, and hide `key` while it saves. */
  const save = async (
    key: string,
    subject: InboxSnoozeSubjectBody,
    untilMs: number,
  ) => {
    const lastChangedAtMs = changedAtMs;
    hide(key, Infinity);
    setChangedAtMs(Infinity);
    try {
      const body: InboxSnoozeCreateBody = {
        ...subject,
        wakeAt: new Date(untilMs).toISOString(),
      };
      await post(inboxSnoozeSchema, SNOOZES_PATH, body);
    } catch {
      // The row leaves while the snooze saves, so a failure brings it back.
      hide(key, undefined);
      setChangedAtMs(lastChangedAtMs);
      toast.add({ title: "The row could not be snoozed", type: "error" });
      return;
    }
    // The refetch cancels reads in flight, so every read that ends after
    // it started after the save.
    const savedAtMs = Date.now();
    await invalidateReviewItemCollections(queryClient);
    hide(key, savedAtMs);
    setChangedAtMs(savedAtMs);
  };
  /** Undo the viewer's snoozes on `subject`, and mark its items waking. */
  const unsnooze = async (
    itemIds: readonly string[],
    subject: InboxSnoozeSubjectBody,
  ) => {
    const lastChangedAtMs = changedAtMs;
    setWaking((current) => new Set([...current, ...itemIds]));
    setChangedAtMs(Infinity);
    try {
      await deleteDashboardResource(SNOOZES_PATH, subject);
      const savedAtMs = Date.now();
      await invalidateReviewItemCollections(queryClient);
      setChangedAtMs(savedAtMs);
    } catch {
      setChangedAtMs(lastChangedAtMs);
      // The row stays in Snoozed, so say why it did not wake.
      toast.add({ title: "The row could not be woken", type: "error" });
    } finally {
      setWaking((current) => {
        const next = new Set(current);
        for (const id of itemIds) next.delete(id);
        return next;
      });
    }
  };
  /**
   * Snooze a row until `untilMs`. A root Conversation's row, such as a
   * stack's Snooze all, snoozes each of its open items; a row of one item,
   * such as an FYI notice, only that item.
   */
  const snooze = (bundle: InboxBundle, untilMs: number) =>
    save(
      bundle.key,
      {
        conversationId: bundle.conversationId,
        ...(bundle.key === bundle.conversationId
          ? undefined
          : { reviewItemId: bundle.key }),
      },
      untilMs,
    );
  /** Snooze one item until `untilMs`. The rest of its stack stays. */
  const snoozeItem = (item: ReviewItemPayload, untilMs: number) =>
    save(
      item.id,
      { conversationId: item.rootConversationId, reviewItemId: item.id },
      untilMs,
    );
  /** Wake a snoozed row now: undo the viewer's snoozes on its items. */
  const wake = (bundle: InboxBundle) =>
    unsnooze(
      bundle.items.map((item) => item.id),
      {
        conversationId: bundle.conversationId,
        ...(bundle.key === bundle.conversationId
          ? undefined
          : { reviewItemId: bundle.key }),
      },
    );
  /** Wake one item now. The other items of its stack stay snoozed. */
  const wakeItem = (item: ReviewItemPayload) =>
    unsnooze([item.id], {
      conversationId: item.rootConversationId,
      reviewItemId: item.id,
    });
  return {
    /**
     * The item's row was just snoozed, and the lists have not refreshed
     * yet: the item alone, or a Conversation that added or links it. The
     * server also hides items that link a thread of that Conversation;
     * those leave when the lists refresh.
     */
    hides: (item: ReviewItemPayload) =>
      hiddenNow(item.id) ||
      hiddenNow(item.rootConversationId) ||
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
    snoozeItem,
    wake,
    wakeItem,
    /** The item was just woken, and the lists have not refreshed yet. */
    waking: (itemId: string) => waking.has(itemId),
  };
}
