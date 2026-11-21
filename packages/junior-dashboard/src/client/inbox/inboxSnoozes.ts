import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  inboxSnoozeResourceSchema,
  inboxSnoozeSchema,
  type InboxSnoozeCreateBody,
  type InboxSnoozeResource,
  type InboxSnoozeSubjectBody,
  type InboxSnoozeWake,
  type InboxItemPayload,
} from "@sentry/junior/api/schema";
import { useState } from "react";

import { useToastManager } from "../components/ui/toast";
import { useDebouncedValue } from "../debouncedValue";
import { deleteDashboardResource, fetchDashboardJson, post } from "../http";
import { invalidateInboxItemCollections } from "./queries";
import { itemConversationId, type InboxBundle } from "./inboxItemFormat";
import type { CustomSnoozeEnd } from "./snoozeChoices";

const SNOOZES_PATH = "/api/inbox/snoozes";

/** When a snooze ends: at a time, as `Date.now()`, or a custom snooze. */
export type SnoozeEnd = number | CustomSnoozeEnd;

/** The API body of a snooze end. */
function snoozeEndBody(end: SnoozeEnd) {
  const untilMs = typeof end === "number" ? end : end.untilMs;
  const triggers = typeof end === "number" ? [] : end.triggers;
  return {
    triggers: triggers.length > 0 ? triggers : undefined,
    wakeAt: untilMs === undefined ? undefined : new Date(untilMs).toISOString(),
  };
}

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

/** The snooze subject of one item: its item in its root's row, or itself. */
function itemSubject(item: InboxItemPayload): InboxSnoozeSubjectBody {
  return item.rootConversationId
    ? { conversationId: item.rootConversationId, inboxItemId: item.id }
    : { inboxItemId: item.id };
}

/**
 * The snooze subject of a row: a root Conversation's stack, one item of it,
 * or the item of an owner that is not a Conversation. Such an owner, an
 * Automation, has one open alert at a time, so its stack is that item.
 */
function rowSubject(bundle: InboxBundle): InboxSnoozeSubjectBody {
  if (!bundle.conversationId) return { inboxItemId: bundle.newest.id };
  return bundle.key === bundle.conversationId
    ? { conversationId: bundle.conversationId }
    : { conversationId: bundle.conversationId, inboxItemId: bundle.key };
}

/**
 * Snooze Inbox items on the server, so a snooze holds in every browser. A
 * row snoozes its item, and a stack's Snooze its root's items. An item
 * wakes at its time or on its Event, or when its root Conversation adds an
 * item; the versions poll then refreshes the lists. The server hides
 * snoozed rows from the Inbox lists and counts; until the Inbox list reads
 * the server again, `hides` keeps a row that was just snoozed out of the
 * lists, and `waking` one that was just woken.
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
  // The wake that the viewer opened, by item id. The server forgets it at
  // once; the lists keep their copy until they read again. A later wake of
  // the same item is a new object, so it shows.
  const [openedWakes, setOpenedWakes] = useState<
    ReadonlyMap<string, InboxSnoozeWake>
  >(new Map());
  // When the viewer's last snooze change saved and the lists refetched.
  // Snoozed read before that time may be stale.
  const [savedAtMs, setSavedAtMs] = useState(-Infinity);
  // The snooze changes in flight. Snoozed may be stale until all settle.
  const [changing, setChanging] = useState(0);
  const changedAtMs = changing > 0 ? Infinity : savedAtMs;
  const startChange = () => setChanging((count) => count + 1);
  const endChange = (saved?: number) => {
    if (saved !== undefined) setSavedAtMs((last) => Math.max(last, saved));
    setChanging((count) => count - 1);
  };
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
    end: SnoozeEnd,
  ) => {
    hide(key, Infinity);
    startChange();
    try {
      const body: InboxSnoozeCreateBody = { ...subject, ...snoozeEndBody(end) };
      await post(inboxSnoozeSchema, SNOOZES_PATH, body);
    } catch {
      // The row leaves while the snooze saves, so a failure brings it back.
      hide(key, undefined);
      endChange();
      toast.add({ title: "The row could not be snoozed", type: "error" });
      return;
    }
    // The refetch cancels reads in flight, so every read that ends after
    // it started after the save.
    const saved = Date.now();
    await invalidateInboxItemCollections(queryClient);
    hide(key, saved);
    endChange(saved);
  };
  /** Undo the viewer's snoozes on `subject`, and mark its items waking. */
  const unsnooze = async (
    itemIds: readonly string[],
    subject: InboxSnoozeSubjectBody,
  ) => {
    setWaking((current) => new Set([...current, ...itemIds]));
    startChange();
    try {
      await deleteDashboardResource(SNOOZES_PATH, subject);
      const saved = Date.now();
      await invalidateInboxItemCollections(queryClient);
      endChange(saved);
    } catch {
      endChange();
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
   * Snooze a row until `end`. A root Conversation's row, such as a stack's
   * Snooze, snoozes each of its open items; a row of one item, such as an
   * FYI notice, only that item.
   */
  const snooze = (bundle: InboxBundle, end: SnoozeEnd) =>
    save(bundle.key, rowSubject(bundle), end);
  /** Snooze one item until `end`. The rest of its stack stays. */
  const snoozeItem = (item: InboxItemPayload, end: SnoozeEnd) =>
    save(item.id, itemSubject(item), end);
  /** Wake a snoozed row now: undo the viewer's snoozes on its items. */
  const wake = (bundle: InboxBundle) =>
    unsnooze(
      bundle.items.map((item) => item.id),
      rowSubject(bundle),
    );
  /** Wake one item now. The other items of its stack stay snoozed. */
  const wakeItem = (item: InboxItemPayload) =>
    unsnooze([item.id], itemSubject(item));
  const wakeOpened = (item: InboxItemPayload) =>
    item.wake !== undefined && openedWakes.get(item.id) === item.wake;
  /**
   * The viewer opened these items, so the server forgets why they woke. If
   * that fails, they say it again.
   */
  const openWoken = (items: readonly InboxItemPayload[]) => {
    const woken = items.filter((item) => item.wake && !wakeOpened(item));
    if (woken.length === 0) return;
    const mark = (opened: boolean) =>
      setOpenedWakes((current) => {
        const next = new Map(current);
        for (const item of woken) {
          if (opened && item.wake) next.set(item.id, item.wake);
          else if (next.get(item.id) === item.wake) next.delete(item.id);
        }
        return next;
      });
    mark(true);
    deleteDashboardResource(`${SNOOZES_PATH}/wakes`, {
      inboxItemIds: woken.map((item) => item.id),
    }).catch(() => mark(false));
  };
  return {
    /**
     * The item's row was just snoozed, and the lists have not refreshed
     * yet: the item alone, or a Conversation that added or links it. The
     * server also hides items that link a thread of that Conversation;
     * those leave when the lists refresh.
     */
    hides: (item: InboxItemPayload) =>
      [
        item.id,
        item.rootConversationId,
        itemConversationId(item),
        ...item.conversationIds,
      ].some((key) => key !== undefined && hiddenNow(key)),
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
    openWoken,
    /** The viewer opened the item since it woke. */
    wakeOpened,
    snooze,
    snoozeItem,
    wake,
    wakeItem,
    /** The item was just woken, and the lists have not refreshed yet. */
    waking: (itemId: string) => waking.has(itemId),
  };
}

/** What the server says about the page that a person names for a snooze. */
type SnoozeResourceRead =
  | { state: "empty" | "invalid" | "loading" | "unavailable" }
  | { resource: InboxSnoozeResource; state: "found" };

/**
 * The Events of the page at `url` that the viewer can snooze on, such as a
 * pasted pull request. The server answers 404 for a page without Events or
 * one that the viewer cannot see. It reads once the typing stops.
 */
export function useSnoozeResource(url: string): SnoozeResourceRead {
  const settled = useDebouncedValue(url);
  const query = useQuery({
    enabled: settled !== "" && URL.canParse(settled),
    queryFn: () =>
      fetchDashboardJson(
        inboxSnoozeResourceSchema,
        `${SNOOZES_PATH}/resource?${new URLSearchParams({ url: settled })}`,
      ),
    queryKey: ["inbox-snooze-resource", settled],
    retry: false,
    staleTime: 60_000,
  });
  if (url === "") return { state: "empty" };
  if (!URL.canParse(url)) return { state: "invalid" };
  if (settled !== url || query.isPending) return { state: "loading" };
  return query.data
    ? { resource: query.data, state: "found" }
    : { state: "unavailable" };
}
