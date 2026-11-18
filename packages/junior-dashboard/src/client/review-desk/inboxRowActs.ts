import type {
  ReviewItemActionBody,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";
import pLimit from "p-limit";
import type { RefObject } from "react";

import { useToastManager } from "../components/ui/toast";
import { useReviewItemAction } from "./queries";
import { viewerAnswerLine } from "./reviewItemFormat";
import { showReturnedRow, type useLeaveRow } from "./rowMotion";

/** The Inbox row that an action acts on, as it shows now. */
type ActedRow = {
  items: readonly ReviewItemPayload[];
  key: string;
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
 * leaves, and the next one opens. Actions in flight settle one by one.
 *
 * An answer says what the viewer answered in a toast as it goes, so the
 * row that leaves at once still confirms it.
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
  scroller: RefObject<HTMLElement | null>;
  setExpandedKey(key: string): void;
}) {
  const action = useReviewItemAction({ optimistic: true });
  const { add, close } = useToastManager();
  const { holdLeaving, leave, scroller, setExpandedKey } = options;

  const act = async (
    row: ActedRow,
    items: readonly ReviewItemPayload[],
    body: ReviewItemActionBody,
  ): Promise<void> => {
    const toastId = `inbox-action-error:${row.key}`;
    const answerToastId = `inbox-answer:${row.key}`;
    close(toastId);
    const ids = new Set(items.map((item) => item.id));
    const open = row.items.filter((item) => item.status === "open");
    let opened: string | undefined;
    if (body.action !== "take" && open.every((item) => ids.has(item.id))) {
      // The read drops the items at once. Hold them while the row leaves.
      holdLeaving(open, true);
      opened = leave(row.key, () => holdLeaving(open, false));
    }
    const [answered] = items;
    const answerTitle =
      body.action === "submit" && answered
        ? viewerAnswerLine({
            answer: { ...body.answer, requestId: answered.id },
            request: answered.request,
          })
        : undefined;
    if (answerTitle) {
      add({
        description: row.title,
        id: answerToastId,
        title: answerTitle,
        type: "success",
      });
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
    // The failure toast takes the place of the answer's.
    close(answerToastId);
    const area = scroller.current;
    if (area) {
      if (opened !== undefined && openRowKey(area) === opened && !typing())
        setExpandedKey(row.key);
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
