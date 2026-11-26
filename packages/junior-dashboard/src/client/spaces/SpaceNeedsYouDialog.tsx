import { ChevronDown, ChevronLeft, ChevronUp, X } from "lucide-react";
import { useState } from "react";
import type {
  InboxItemActionBody,
  InboxItemPayload,
} from "@sentry/junior/api/schema";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "../components/ui/dialog";
import { useToastManager } from "../components/ui/toast";
import { useSheet } from "../components/ui/useSheet";
import { CodeChangeOpenButton } from "../inbox/CodeChangeTitle";
import { codeChangeHead } from "../inbox/codeChangeHead";
import {
  inboxItemTitleText,
  itemOwnerLinkLabel,
  itemOwnerPath,
} from "../inbox/inboxItemFormat";
import type { SnoozeEnd } from "../inbox/inboxSnoozes";
import { InboxRowCard } from "../inbox/InboxRowCard";
import { useInboxItemAction } from "../inbox/queries";
import { FAILED_TITLES } from "../inbox/inboxRowActs";
import { RowOwnerLink } from "../inbox/RowOwnerLink";
import { eventSnoozeOf } from "../inbox/snoozeChoices";
import type { Conversation } from "../types";
import { NeedsYouTitle } from "./NeedsYouTitle";

const NO_NOTICES: readonly InboxItemPayload[] = [];

const HEADER_BUTTON_CLASS =
  "size-9 border-0 bg-transparent p-0 text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text";

/**
 * One item of a Space's Needs you list at a time, in the Inbox's open row
 * card. After an answer, a dismiss, or a snooze, the next item shows, and
 * the dialog closes when no item is left. On a phone it fills the screen.
 */
export function SpaceNeedsYouDialog(props: {
  conversationOf(id: string | undefined): Conversation | undefined;
  /** The shown item's place in `items`. */
  index: number;
  items: readonly InboxItemPayload[];
  /** Runs once the dialog has closed. */
  onClose(): void;
  /**
   * Show another item. `index` is where it is now, or where it will be once
   * the item before it leaves.
   */
  onShow(itemId: string, index: number): void;
  snooze(item: InboxItemPayload, end: SnoozeEnd): void;
  titleOf(rootConversationId: string | undefined): string;
}) {
  const sheet = useSheet(props.onClose);
  const action = useInboxItemAction({ optimistic: true });
  const toast = useToastManager();
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  const { index, items } = props;
  const count = items.length;
  const item = items[index];
  if (!item) return null;
  const head = codeChangeHead(
    item,
    props.conversationOf(item.rootConversationId),
  );
  // The item leaves before the server answers. The next item shows, from
  // the top after the end. After the last item, the dialog closes with its
  // exit motion.
  const leave = () => {
    setSnoozeMenuOpen(false);
    const after = items[index + 1];
    if (after) props.onShow(after.id, index);
    else if (count > 1) props.onShow(items[0]!.id, 0);
    else sheet.close();
  };
  const act = async (acted: InboxItemPayload, body: InboxItemActionBody) => {
    if (body.action !== "take") leave();
    try {
      await action.mutateAsync({ body, id: acted.id });
    } catch (failure) {
      // The item comes back to the list, so the dialog shows it again,
      // with the answer's draft (`useFailedInboxItemAnswer`).
      props.onShow(acted.id, index);
      toast.add({
        description: inboxItemTitleText(acted),
        title: FAILED_TITLES[body.action],
        type: "error",
      });
      throw failure;
    }
  };
  const snooze = (end: SnoozeEnd) => {
    leave();
    props.snooze(item, end);
  };
  // Wrap at the ends. A disabled button would drop focus out of the dialog.
  const show = (offset: number) => {
    const next = (index + offset + count) % count;
    props.onShow(items[next]!.id, next);
  };
  return (
    <Dialog {...sheet.rootProps}>
      <DialogContent
        {...sheet.contentProps}
        className="max-w-2xl gap-0 p-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:rounded-none max-sm:border-0"
      >
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] max-sm:h-full">
          <header className="flex items-center gap-1 border-b border-dashboard-border py-1.5 pr-2 pl-2 pt-[max(0.375rem,env(safe-area-inset-top))] sm:pl-5">
            <DialogClose
              render={
                <Button
                  aria-label="Back"
                  className={`${HEADER_BUTTON_CLASS} sm:hidden`}
                  variant="outline"
                />
              }
            >
              <ChevronLeft aria-hidden="true" size={18} />
            </DialogClose>
            <DialogTitle className="min-w-0 flex-1 truncate font-sans text-xs font-normal text-dashboard-text-muted">
              {props.titleOf(item.rootConversationId)}
            </DialogTitle>
            <span className="shrink-0 px-1 text-xs tabular-nums text-dashboard-text-muted">
              {index + 1} of {count}
            </span>
            {count > 1 ? (
              <>
                <Button
                  aria-label="Previous item"
                  className={HEADER_BUTTON_CLASS}
                  onClick={() => show(-1)}
                  variant="outline"
                >
                  <ChevronUp aria-hidden="true" size={16} />
                </Button>
                <Button
                  aria-label="Next item"
                  className={HEADER_BUTTON_CLASS}
                  onClick={() => show(1)}
                  variant="outline"
                >
                  <ChevronDown aria-hidden="true" size={16} />
                </Button>
              </>
            ) : null}
            <DialogClose
              render={
                <Button
                  aria-label="Close"
                  className={`${HEADER_BUTTON_CLASS} max-sm:hidden`}
                  variant="outline"
                />
              }
            >
              <X aria-hidden="true" size={16} />
            </DialogClose>
          </header>
          <div
            className="grid min-h-0 content-start gap-3 overflow-y-auto px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
            key={item.id}
          >
            <div className="grid min-w-0 gap-1">
              <h3 className="m-0 break-words font-sans text-base font-semibold leading-snug text-dashboard-text">
                <NeedsYouTitle head={head} item={item} />
              </h3>
              {item.addedByLabel ? (
                <p className="m-0 truncate text-xs text-dashboard-text-muted">
                  {item.addedByLabel}
                </p>
              ) : null}
            </div>
            <InboxRowCard
              actions={{
                eventSnooze: eventSnoozeOf([item], snooze),
                onDismiss: item.canAct
                  ? () => void act(item, { action: "dismiss" }).catch(() => {})
                  : undefined,
                onSnooze: snooze,
                onSnoozeMenu: setSnoozeMenuOpen,
                snoozeMenuOpen,
              }}
              headTitled
              item={item}
              notices={NO_NOTICES}
              onAction={act}
              primaryAction={
                head ? <CodeChangeOpenButton head={head} /> : undefined
              }
              rowActions={
                <RowOwnerLink
                  look={head ? "tall" : undefined}
                  open={{
                    automation: item.owner.kind === "automation",
                    label: itemOwnerLinkLabel(item),
                    path: itemOwnerPath(item, { askItemId: item.id }),
                  }}
                />
              }
              wake={item.wake}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
