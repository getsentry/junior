import type {
  ReviewItemActionBody,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";
import pLimit from "p-limit";
import type { RefObject } from "react";

import { useToastManager } from "../components/ui/toast";
import { useReviewItemAction } from "./queries";
import type { InboxCardActions } from "./RowHoverActions";
import {
  showReturnedRow,
  type useLeaveCard,
  type useLeaveRow,
} from "./rowMotion";

/** The Inbox row that an action acts on, as it shows now. */
type ActedRow = {
  items: readonly ReviewItemPayload[];
  key: string;
  /** Rows that leave with this one, as its stack in To do. */
  passing?: ReadonlySet<string>;
  /** The row that opens again when the action fails, when not this one. */
  reopen?: string;
  title: string;
};

// Action requests that one row sends at once.
const ROW_ACTION_REQUESTS = 8;

const FAILED_TITLES: Record<ReviewItemActionBody["action"], string> = {
  dismiss: "Could not dismiss",
  submit: "Could not send your answer",
  take: "Could not take it",
};

function typing(): boolean {
  const focused = document.activeElement;
  return (
    focused instanceof HTMLInputElement ||
    focused instanceof HTMLTextAreaElement ||
    (focused instanceof HTMLElement && focused.isContentEditable)
  );
}

function openRowKey(scroller: HTMLElement): string {
  return (
    scroller.querySelector<HTMLElement>("li[data-inbox-row][data-expanded]")
      ?.dataset["inboxRow"] ?? ""
  );
}

/**
 * Act on the items of Inbox rows before the server answers. An action that
 * closes every open item of a row puts the row away as it starts: the row
 * leaves, and the next one opens, in its stack first. An action on one card
 * of a row with more puts only that card away. Actions in flight settle
 * one by one.
 *
 * When an action fails, its items come back in their places, and a toast
 * names the action and offers Retry. The row opens again only when the
 * viewer has not moved on: the row that opened in its place is still the
 * open one, and they are not typing. A near row scrolls into view. A failed
 * answer keeps its draft (`useFailedReviewItemAnswer`). The returned
 * promise rejects when an action fails.
 */
export function useInboxRowActs(options: {
  holdLeaving(items: readonly ReviewItemPayload[], held: boolean): void;
  leave: ReturnType<typeof useLeaveRow>;
  leaveCard: ReturnType<typeof useLeaveCard>;
  scroller: RefObject<HTMLElement | null>;
  setExpandedKey(key: string): void;
}) {
  const action = useReviewItemAction({ optimistic: true });
  const { add, close } = useToastManager();
  const { holdLeaving, leave, leaveCard, scroller, setExpandedKey } = options;

  const act = async (
    row: ActedRow,
    items: readonly ReviewItemPayload[],
    body: ReviewItemActionBody,
  ): Promise<void> => {
    const toastId = `inbox-action-error:${row.key}`;
    close(toastId);
    const ids = new Set(items.map((item) => item.id));
    const open = row.items.filter((item) => item.status === "open");
    let opened: string | undefined;
    const [only] = items;
    if (body.action !== "take" && open.every((item) => ids.has(item.id))) {
      // The read drops the items at once. Hold them while the row leaves.
      holdLeaving(open, true);
      opened = leave(row.key, () => holdLeaving(open, false), row.passing);
    } else if (body.action !== "take" && only && items.length === 1) {
      holdLeaving(items, true);
      opened = leaveCard(row.key, only.id, () => holdLeaving(items, false));
    }
    const limit = pLimit(ROW_ACTION_REQUESTS);
    const results = await Promise.allSettled(
      items.map((item) =>
        limit(() => action.mutateAsync({ body, id: item.id })),
      ),
    );
    const failed = items.filter(
      (_, index) => results[index]?.status === "rejected",
    );
    if (failed.length === 0) return;
    const area = scroller.current;
    if (area) {
      if (opened !== undefined && openRowKey(area) === opened && !typing())
        setExpandedKey(row.reopen ?? row.key);
      showReturnedRow(area, row.key);
    }
    const title = FAILED_TITLES[body.action];
    add({
      actionProps: {
        children: "Retry",
        onClick: () => {
          close(toastId);
          // The row keeps every item that did not close, so a Retry of
          // some of them does not put the whole row away.
          const closed = new Set(
            items
              .filter((_, index) => results[index]?.status === "fulfilled")
              .map((item) => item.id),
          );
          const rest = row.items.filter((item) => !closed.has(item.id));
          void act({ ...row, items: rest }, failed, body).catch(() => {});
        },
      },
      description: row.title,
      id: toastId,
      title,
      type: "error",
    });
    throw new Error(title);
  };
  return act;
}

/**
 * Each card's own Dismiss and Snooze in an Inbox row. A stack row leaves
 * with the rows that go with it. A card of a row with more leaves by itself.
 */
export function inboxCardActions(input: {
  act: ReturnType<typeof useInboxRowActs>;
  leave: ReturnType<typeof useLeaveRow>;
  leaveCard: ReturnType<typeof useLeaveCard>;
  setSnoozeKey(key: string | undefined): void;
  snoozeItem(item: ReviewItemPayload, untilMs: number): void;
  snoozeKey?: string;
}) {
  const { act, leave, leaveCard, setSnoozeKey } = input;
  return (row: ActedRow, options: { snoozed?: boolean }) =>
    (item: ReviewItemPayload): InboxCardActions => {
      const menuKey = `${row.key}:${item.id}`;
      const putAway = (release: () => void) =>
        row.passing
          ? leave(row.key, release, row.passing)
          : leaveCard(row.key, item.id, release);
      return {
        onDismiss:
          item.status === "open" && item.canAct
            ? () => void act(row, [item], { action: "dismiss" }).catch(() => {})
            : undefined,
        onSnooze: options.snoozed
          ? undefined
          : (untilMs) => {
              setSnoozeKey(undefined);
              putAway(() => input.snoozeItem(item, untilMs));
            },
        onSnoozeMenu: (open) => setSnoozeKey(open ? menuKey : undefined),
        snoozeMenuOpen: input.snoozeKey === menuKey,
      };
    };
}

/**
 * A stack's own actions: Snooze, for every row, and Dismiss, which closes every
 * open ask of the stack that the viewer can act on. A snoozed stack has
 * neither. Dismiss puts the whole stack away (`useLeaveRow`), so the
 * next row after it opens.
 */
export function inboxStackActions(input: {
  act: ReturnType<typeof useInboxRowActs>;
  expandedKey: string;
  items: readonly ReviewItemPayload[];
  /** The stack's row keys, in order. */
  keys: readonly string[];
  snooze(untilMs: number): void;
  snoozed?: boolean;
  stackKey: string;
  title: string;
}): {
  dismissCount?: number;
  onDismiss?(): void;
  onSnooze?(untilMs: number): void;
} {
  if (input.snoozed) return {};
  const open = input.items.filter(
    (item) => item.status === "open" && item.canAct,
  );
  const row: ActedRow = {
    items: input.items,
    key: input.stackKey,
    ...(input.keys.includes(input.expandedKey)
      ? { reopen: input.expandedKey }
      : undefined),
    title: input.title,
  };
  return {
    dismissCount: open.length,
    onDismiss:
      open.length > 0
        ? () => void input.act(row, open, { action: "dismiss" }).catch(() => {})
        : undefined,
    onSnooze: input.snooze,
  };
}
