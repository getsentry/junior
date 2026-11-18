import { Check, Clock3 } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";

import { Button } from "../components/ui/button";
import { FieldError } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import {
  ATTENTION_TONE_CLASS,
  OPEN_TONE_CLASS,
} from "../conversations/ConversationMeta";
import { cn } from "../styles";
import { formatTime } from "../time";
import {
  atLocalHour,
  type SnoozeChoice,
  snoozeChoicesAt,
  snoozeUntil,
} from "./inboxSnooze";

const MENU_ROW_CLASS =
  "flex cursor-pointer items-baseline justify-between gap-3 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left font-sans text-sm text-dashboard-text hover:bg-dashboard-fill-hover focus-visible:bg-dashboard-fill-hover focus-visible:outline-none";

/** "14:00" today, else "Tue 09:00", in the browser's timezone. */
function targetTime(untilMs: number, nowMs: number): string {
  const sameDay =
    new Date(untilMs).toDateString() === new Date(nowMs).toDateString();
  return formatTime(untilMs, {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    ...(sameDay ? undefined : { weekday: "short" }),
  });
}

/** The `datetime-local` value of a time, in the browser's timezone. */
function localInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Snooze an Inbox row from its action bar: a menu of the snooze times, and
 * Custom… for a picked date and time. Number keys pick the menu rows.
 */
export function RowSnoozeButton(props: {
  onOpenChange(open: boolean): void;
  onSnooze(choice: SnoozeChoice): void;
  open: boolean;
}) {
  const [custom, setCustom] = useState(false);
  // Back from the picker focuses Custom… again, so the keys still work.
  const [back, setBack] = useState(false);
  // The menu reads the clock when it opens: each open renders it again.
  const nowMs = Date.now();
  const choices = snoozeChoicesAt(nowMs);
  const onKeyDown = (event: KeyboardEvent) => {
    if (custom || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = Number(event.key) - 1;
    if (!Number.isInteger(index) || index < 0) return;
    const choice = choices[index];
    if (choice) props.onSnooze(choice);
    else if (index === choices.length) setCustom(true);
    else return;
    event.preventDefault();
  };
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          setCustom(false);
          setBack(false);
        }
        props.onOpenChange(open);
      }}
      open={props.open}
    >
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
        // The date and time field needs more room than the times.
        className={cn("grid gap-0.5 p-1", custom ? "w-72" : "w-56")}
        onKeyDown={onKeyDown}
      >
        {custom ? (
          <CustomSnooze
            nowMs={nowMs}
            onBack={() => {
              setCustom(false);
              setBack(true);
            }}
            onSnooze={props.onSnooze}
          />
        ) : (
          <>
            {choices.map((choice, index) => (
              <button
                aria-keyshortcuts={String(index + 1)}
                className={MENU_ROW_CLASS}
                key={choice.label}
                onClick={() => props.onSnooze(choice)}
                type="button"
              >
                {choice.label}
                <span className="text-xs text-dashboard-text-faint tabular-nums">
                  {targetTime(choice.untilMs(nowMs), nowMs)}
                </span>
              </button>
            ))}
            <button
              aria-keyshortcuts={String(choices.length + 1)}
              autoFocus={back}
              className={MENU_ROW_CLASS}
              onClick={() => setCustom(true)}
              type="button"
            >
              Custom…
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Pick a date and time to snooze until. It starts at tomorrow 09:00. */
function CustomSnooze(props: {
  nowMs: number;
  onBack(): void;
  onSnooze(choice: SnoozeChoice): void;
}) {
  const id = useId();
  const [value, setValue] = useState(() =>
    localInputValue(atLocalHour(props.nowMs, 1, 9)),
  );
  const [error, setError] = useState<string>();
  return (
    <form
      className="grid gap-2 p-1.5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        // A `datetime-local` value has no offset, so it parses as local time.
        const untilMs = new Date(value).getTime();
        if (Number.isNaN(untilMs)) setError("Pick a date and time.");
        else if (untilMs <= Date.now()) setError("Pick a time in the future.");
        else props.onSnooze(snoozeUntil(untilMs));
      }}
    >
      <Label className="text-xs text-muted-foreground" htmlFor={`${id}-at`}>
        Date and time
      </Label>
      <Input
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={error ? true : undefined}
        autoFocus
        id={`${id}-at`}
        min={localInputValue(props.nowMs)}
        onChange={(event) => {
          setValue(event.target.value);
          setError(undefined);
        }}
        size="comfortable"
        type="datetime-local"
        value={value}
      />
      <FieldError id={`${id}-error`}>{error}</FieldError>
      <div className="flex justify-end gap-1">
        <Button onClick={props.onBack} type="button" variant="ghost">
          Back
        </Button>
        <Button type="submit" variant="outline">
          Snooze
        </Button>
      </div>
    </form>
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
