import { Clock3, X } from "lucide-react";

import { Button } from "../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { ATTENTION_TONE_CLASS } from "../conversations/ConversationMeta";
import { type SnoozeChoice, snoozeChoices } from "./inboxSnooze";

/** Snooze an Inbox row from its action bar: a menu of the snooze times. */
export function RowSnoozeButton(props: {
  onOpenChange(open: boolean): void;
  onSnooze(choice: SnoozeChoice): void;
  open: boolean;
}) {
  return (
    <Popover onOpenChange={props.onOpenChange} open={props.open}>
      <PopoverTrigger
        render={
          <Button variant="ghost">
            <Clock3
              aria-hidden="true"
              className={ATTENTION_TONE_CLASS}
              size={15}
            />
            Snooze
          </Button>
        }
      />
      <PopoverContent
        align="start"
        aria-label="Snooze until"
        className="grid w-48 gap-0.5 p-1"
      >
        {snoozeChoices.map((choice) => (
          <button
            className="cursor-pointer rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left font-sans text-sm text-dashboard-text hover:bg-dashboard-fill-hover"
            key={choice.label}
            onClick={() => props.onSnooze(choice)}
            type="button"
          >
            {choice.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Dismiss an Inbox row. It is quiet like the other actions of its bar, and
 * has no check mark, so it does not read as an answer or an approval.
 */
export function RowDismissButton(props: {
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <Button disabled={props.disabled} onClick={props.onClick} variant="ghost">
      <X aria-hidden="true" size={15} />
      Dismiss
    </Button>
  );
}
