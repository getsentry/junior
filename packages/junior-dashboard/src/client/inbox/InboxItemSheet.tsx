import { useState, type ReactNode } from "react";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { BottomSheet } from "../components/BottomSheet";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { DisplayText } from "../display-text/DisplayText";
import { InboxItemActions } from "./InboxItemActions";
import { InboxItemObjects } from "./InboxItemObjects";
import { InboxItemTitle } from "./InboxItemPeople";
import { itemConversationId, inboxItemTitleText } from "./inboxItemFormat";

/**
 * Report whether an Inbox item still stands as it did when it opened. Any
 * change, as an answer, a dismiss, or a snooze, closes its sheet or dialog,
 * so the reader is back where they were.
 */
function useStandsAsOpened(item: InboxItemPayload): boolean {
  const standing = `${item.status}:${Boolean(item.snoozedByViewer)}`;
  const [openedStanding] = useState(standing);
  return standing === openedStanding;
}

/** What one Inbox item says, then the viewer's actions or how it closed. */
function InboxItemBody(props: { context?: ReactNode; item: InboxItemPayload }) {
  const { item } = props;
  return (
    <>
      {item.body ? (
        <InboxItemObjects conversationId={itemConversationId(item)}>
          <DisplayText mentions={item.mentions} text={item.body} />
        </InboxItemObjects>
      ) : null}
      <InboxItemActions context={props.context} item={item} />
    </>
  );
}

/**
 * One Inbox item in a phone sheet. On a phone, a transcript record and
 * Conversation details open an item here instead of showing its form in
 * place.
 */
export function InboxItemSheet(props: {
  /** What Junior said around the question, after the question. */
  context?: ReactNode;
  item: InboxItemPayload;
  onClose(): void;
}) {
  const { item } = props;
  return (
    <BottomSheet
      bodyClassName="grid content-start gap-4 p-4 font-sans text-sm text-dashboard-text"
      label={inboxItemTitleText(item)}
      onClose={props.onClose}
      open={useStandsAsOpened(item)}
      size="content"
      title={<InboxItemTitle item={item} links />}
    >
      <InboxItemBody context={props.context} item={item} />
    </BottomSheet>
  );
}

/** One Inbox item in a centered dialog, the desktop form of its sheet. */
export function InboxItemDialog(props: {
  item: InboxItemPayload;
  onClose(): void;
}) {
  const { item } = props;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      open={useStandsAsOpened(item)}
    >
      <DialogContent className="font-sans text-dashboard-text">
        <DialogTitle className="font-sans text-base font-semibold">
          <InboxItemTitle item={item} links />
        </DialogTitle>
        <InboxItemBody item={item} />
      </DialogContent>
    </Dialog>
  );
}
