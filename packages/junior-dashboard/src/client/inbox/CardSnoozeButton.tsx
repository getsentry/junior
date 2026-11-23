import { useState } from "react";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { useSnoozeInboxItem } from "./inboxSnoozes";
import { RowSnoozeButton } from "./RowSnoozeDismiss";
import { eventSnoozeOf } from "./snoozeChoices";

/**
 * Snooze one item from its own card, until a time or an Event, as the
 * Inbox card's Snooze does.
 */
export function CardSnoozeButton(props: { item: InboxItemPayload }) {
  const [open, setOpen] = useState(false);
  const snooze = useSnoozeInboxItem();
  const snoozeUntil = (end: Parameters<typeof snooze>[1]) => {
    setOpen(false);
    void snooze(props.item, end);
  };
  return (
    <RowSnoozeButton
      eventSnooze={eventSnoozeOf([props.item], snoozeUntil)}
      onOpenChange={setOpen}
      onSnooze={snoozeUntil}
      open={open}
    />
  );
}
