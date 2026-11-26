import { useState, type ReactNode } from "react";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { BottomSheet } from "../components/BottomSheet";
import { DisplayText } from "../display-text/DisplayText";
import { InboxItemActions } from "./InboxItemActions";
import { InboxItemObjects } from "./InboxItemObjects";
import { InboxItemTitle } from "./InboxItemPeople";
import { itemConversationId, inboxItemTitleText } from "./inboxItemFormat";

/**
 * One Inbox item in a phone sheet: what it says, and the viewer's actions,
 * or how it closed. On a phone, a transcript record and Conversation
 * details open an item here instead of showing its form in place. An item
 * that closes, as with an answer, or that the viewer snoozes shuts the
 * sheet, so the reader is back where they were.
 */
export function InboxItemSheet(props: {
  /** What Junior said around the question, after the question. */
  context?: ReactNode;
  item: InboxItemPayload;
  onClose(): void;
}) {
  const { item } = props;
  // Any change to how the item stands, as an answer, a dismiss, or a
  // snooze, shuts the sheet.
  const standing = `${item.status}:${Boolean(item.snoozedByViewer)}`;
  const [openedStanding] = useState(standing);
  return (
    <BottomSheet
      bodyClassName="grid content-start gap-4 p-4 font-sans text-sm text-dashboard-text"
      label={inboxItemTitleText(item)}
      onClose={props.onClose}
      open={standing === openedStanding}
      size="content"
      title={<InboxItemTitle item={item} links />}
    >
      {item.body ? (
        <InboxItemObjects conversationId={itemConversationId(item)}>
          <DisplayText mentions={item.mentions} text={item.body} />
        </InboxItemObjects>
      ) : null}
      <InboxItemActions context={props.context} item={item} />
    </BottomSheet>
  );
}
