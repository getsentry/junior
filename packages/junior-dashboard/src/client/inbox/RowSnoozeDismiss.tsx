import { Clock3, X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
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
import { SOMEDAY, snoozeChoicesAt, type EventSnooze } from "./snoozeChoices";

// The custom snooze dialog and its pull request search load on first use,
// so the Inbox's first paint skips their code.
const SnoozeDialog = lazy(() =>
  import("./SnoozeDialog").then((module) => ({
    default: module.SnoozeDialog,
  })),
);

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

/**
 * Snooze an Inbox row, or every row of a stack, from its action bar: a menu
 * of the snooze times, Custom…, which opens a dialog to pick a date
 * and time, Events on the subject of the row's items or on a pull request
 * or issue that the viewer names, or both, and Someday, which lasts until
 * the items close, such as when someone else handles them. Number keys
 * pick the time rows and Custom….
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
          className="grid w-56 gap-0.5 p-1"
          onKeyDown={onKeyDown}
        >
          {choices.map((choice, index) => (
            <button
              aria-keyshortcuts={String(index + 1)}
              className={MENU_ROW_CLASS}
              key={choice.label}
              onClick={() => props.onSnooze(choice.untilMs(nowMs))}
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
            className={MENU_ROW_CLASS}
            onClick={openDialog}
            type="button"
          >
            Custom…
          </button>
          {props.eventSnooze ? (
            <button
              className={MENU_ROW_CLASS}
              onClick={() => props.eventSnooze?.onSnooze(SOMEDAY)}
              type="button"
            >
              Someday
            </button>
          ) : null}
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
 * Dismiss an Inbox row. It is quiet like the other actions of its bar, and
 * has no check mark, so it does not read as an answer or an approval.
 */
export function RowDismissButton(props: {
  disabled?: boolean;
  /** The action bar's look by default (`ButtonLook`). */
  look?: ButtonLook;
  /** "Dismiss" by default. */
  label?: string;
  /** The accessible name, when the label alone does not say what it acts on. */
  name?: string;
  onClick(): void;
}) {
  const label = props.label ?? "Dismiss";
  return (
    <Button
      aria-label={props.name}
      className={props.look && LOOK_CLASSES[props.look]}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.look === "icon" ? label : undefined}
      variant="ghost"
    >
      <X aria-hidden="true" size={15} />
      <ButtonLabel look={props.look}>{label}</ButtonLabel>
    </Button>
  );
}

/**
 * How Snooze and Dismiss look outside the action bar. `quiet`, in a stack
 * header: smaller, and only the icon on a narrow screen. `narrow`, next to
 * a card's main action: as tall as it on a touch screen, and only the
 * icon on a narrow screen.
 * `icon`, as a row's quick action: only the icon, with its label as the
 * name and the tooltip. `tall`, next to a card's main action: as tall as
 * it on a touch screen, with its label, and narrower on a phone.
 */
export type ButtonLook = "icon" | "narrow" | "quiet" | "tall";

/** The box of a button with a `ButtonLook`. */
export const LOOK_CLASSES: Record<ButtonLook, string> = {
  icon: "size-7 p-0",
  narrow: "pointer-coarse:h-11 max-sm:aspect-square max-sm:px-0",
  quiet: "h-7 gap-1.5 px-2 max-sm:w-7 max-sm:px-0",
  tall: "pointer-coarse:h-11 max-sm:px-2",
};

/** A button's label, hidden as its look says but still its name. */
export function ButtonLabel(props: { children: ReactNode; look?: ButtonLook }) {
  if (!props.look || props.look === "tall") return props.children;
  return (
    <span className={props.look === "icon" ? "sr-only" : "max-sm:sr-only"}>
      {props.children}
    </span>
  );
}
