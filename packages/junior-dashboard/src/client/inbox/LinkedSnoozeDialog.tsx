import { useSnoozeInboxItem } from "./inboxSnoozes";
import { useInboxItemData } from "./queries";
import { SnoozeDialog } from "./SnoozeDialog";
import { eventSnoozeOf } from "./snoozeChoices";

/** The snooze dialog of one open item, that `LinkedSnooze` opens. */
export function LinkedSnoozeDialog(props: {
  itemId: string;
  onClose: () => void;
}) {
  const item = useInboxItemData(props.itemId).data;
  const snooze = useSnoozeInboxItem();
  if (!item || item.status !== "open") return null;
  return (
    <SnoozeDialog
      events={eventSnoozeOf([item], (end) => void snooze(item, end))}
      nowMs={Date.now()}
      onClose={props.onClose}
      onSnooze={(end) => void snooze(item, end)}
    />
  );
}
