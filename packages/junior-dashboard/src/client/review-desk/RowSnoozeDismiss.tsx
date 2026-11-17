import { Check, Clock3 } from "lucide-react";

import { Button } from "../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import {
  ATTENTION_TONE_CLASS,
  OPEN_TONE_CLASS,
} from "../conversations/ConversationMeta";
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
 * Dismiss an Inbox row: the main action of its action bar, so it goes
 * right-most.
 */
export function RowDismissButton(props: {
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <Button disabled={props.disabled} onClick={props.onClick} variant="outline">
      <Check aria-hidden="true" className={OPEN_TONE_CLASS} size={15} />
      Dismiss
    </Button>
  );
}
