import { Check, Clock3 } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactElement,
  lazy,
  Suspense,
  useState,
} from "react";

import { Button } from "../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { ATTENTION_TONE_CLASS } from "../conversations/ConversationMeta";
import { formatTime } from "../time";
import { ButtonLabel, LOOK_CLASSES, type ButtonLook } from "./RowDismissButton";
import { SOMEDAY, snoozeChoicesAt, type EventSnooze } from "./snoozeChoices";

// The custom snooze dialog and its pull request search load on first use,
// so the Inbox's first paint skips their code.
const SnoozeDialog = lazy(() =>
  import("./SnoozeDialog").then((module) => ({
    default: module.SnoozeDialog,
  })),
);

const PICK_CLASS =
  "cursor-pointer rounded-md border-0 bg-transparent font-sans text-sm text-dashboard-text hover:bg-dashboard-fill-hover focus-visible:bg-dashboard-fill-hover focus-visible:outline-none";

const MENU_ROW_CLASS = `${PICK_CLASS} flex items-baseline justify-between gap-3 px-2.5 py-1.5 text-left sm:py-1`;

// A duration cell: its label over its wake time.
const DURATION_CLASS = `${PICK_CLASS} flex flex-col items-center px-1 py-1.5`;

const TIME_CLASS = "text-xs text-dashboard-text-faint tabular-nums";

const CLOCK = { hour: "2-digit", hourCycle: "h23", minute: "2-digit" } as const;

/** "14:00" today, else "Tue 09:00", in the browser's timezone. */
function targetTime(untilMs: number, nowMs: number): string {
  const sameDay =
    new Date(untilMs).toDateString() === new Date(nowMs).toDateString();
  return formatTime(untilMs, {
    ...CLOCK,
    ...(sameDay ? undefined : { weekday: "short" }),
  });
}

/**
 * Snooze an Inbox row, or every row of a stack, from its action bar: a menu
 * of the snooze times, Someday, which lasts until the items close, such as
 * when someone else handles them, and last Custom…, which opens a dialog to
 * pick a date and time, Events on the subject of the row's items or on a
 * pull request or issue that the viewer names, or both. Number keys pick
 * the times and Custom….
 */
export function RowSnoozeButton(props: {
  /** Set when the row can snooze until an Event. */
  eventSnooze?: EventSnooze | undefined;
  /** The action bar's look by default (`ButtonLook`). */
  look?: ButtonLook;
  /** "Snooze" by default. */
  label?: string;
  /** The accessible name, when the label alone does not say what it acts on. */
  name?: string;
  onOpenChange(open: boolean): void;
  /** Called with the wake time that the picked row shows. */
  onSnooze(untilMs: number): void;
  open: boolean;
  /** Another trigger, such as a row's quick action. */
  trigger?: ReactElement;
}) {
  const [dialog, setDialog] = useState(false);
  // The menu reads the clock when it opens: each open renders it again.
  const nowMs = Date.now();
  const choices = snoozeChoicesAt(nowMs);
  // Each choice's number key follows menu order, across both groups.
  const picks = choices.map((choice, index) => {
    const untilMs = choice.untilMs(nowMs);
    return {
      key: String(index + 1),
      label: choice.label,
      short: choice.short,
      // A duration cell is too narrow for a weekday; its name keeps it.
      clock: formatTime(untilMs, CLOCK),
      time: targetTime(untilMs, nowMs),
      untilMs,
    };
  });
  // The dialog outlives the menu, which closes as it opens.
  const openDialog = () => {
    props.onOpenChange(false);
    setDialog(true);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = Number(event.key) - 1;
    if (!Number.isInteger(index) || index < 0) return;
    const choice = choices[index];
    if (choice) props.onSnooze(choice.untilMs(nowMs));
    else if (index === choices.length) openDialog();
    else return;
    event.preventDefault();
  };
  return (
    <>
      <Popover onOpenChange={props.onOpenChange} open={props.open}>
        <PopoverTrigger
          render={
            props.trigger ?? (
              <Button
                aria-label={props.name}
                className={props.look && LOOK_CLASSES[props.look]}
                title={
                  props.look === "icon" ? (props.label ?? "Snooze") : undefined
                }
                variant="ghost"
              >
                <Clock3
                  aria-hidden="true"
                  className={ATTENTION_TONE_CLASS}
                  size={15}
                />
                <ButtonLabel look={props.look}>
                  {props.label ?? "Snooze"}
                </ButtonLabel>
              </Button>
            )
          }
        />
        <PopoverContent
          align="start"
          aria-label="Snooze until"
          className="grid w-56 gap-1 p-1"
          onKeyDown={onKeyDown}
        >
          {/* Durations share one row; the rest are a row each. */}
          <div className="grid grid-cols-4 gap-0.5">
            {picks
              .filter((pick) => pick.short)
              .map((pick) => (
                <button
                  aria-keyshortcuts={pick.key}
                  aria-label={`${pick.label} ${pick.time}`}
                  className={DURATION_CLASS}
                  key={pick.label}
                  onClick={() => props.onSnooze(pick.untilMs)}
                  type="button"
                >
                  {pick.short}
                  <span className={TIME_CLASS}>{pick.clock}</span>
                </button>
              ))}
          </div>
          <div className="grid gap-0.5">
            {picks
              .filter((pick) => !pick.short)
              .map((pick) => (
                <button
                  aria-keyshortcuts={pick.key}
                  className={MENU_ROW_CLASS}
                  key={pick.label}
                  onClick={() => props.onSnooze(pick.untilMs)}
                  type="button"
                >
                  {pick.label}
                  <span className={TIME_CLASS}>{pick.time}</span>
                </button>
              ))}
          </div>
          {/* Custom… opens a dialog, so it stays last. */}
          <div className="flex gap-0.5 border-t border-dashboard-border-subtle pt-1">
            {props.eventSnooze ? (
              <button
                className={`${MENU_ROW_CLASS} flex-1`}
                onClick={() => props.eventSnooze?.onSnooze(SOMEDAY)}
                type="button"
              >
                Someday
              </button>
            ) : null}
            <button
              aria-keyshortcuts={String(choices.length + 1)}
              className={`${MENU_ROW_CLASS} flex-1`}
              onClick={openDialog}
              type="button"
            >
              Custom…
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {dialog ? (
        <Suspense fallback={null}>
          <SnoozeDialog
            events={props.eventSnooze}
            nowMs={nowMs}
            onClose={() => setDialog(false)}
            onSnooze={(end) => {
              if (end.untilClosed || end.triggers.length > 0) {
                props.eventSnooze?.onSnooze(end);
              } else if (end.untilMs !== undefined) props.onSnooze(end.untilMs);
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}

/**
 * Mark a To-do for the viewer done. It takes the place of Dismiss, so the
 * person closes their own work, not hides it.
 */
export function RowDoneButton(props: { look: ButtonLook; onClick(): void }) {
  return (
    <Button
      className={LOOK_CLASSES[props.look]}
      onClick={props.onClick}
      title={props.look === "icon" ? "Done" : undefined}
      variant="ghost"
    >
      <Check aria-hidden="true" size={15} />
      <ButtonLabel look={props.look}>Done</ButtonLabel>
    </Button>
  );
}
