import { Clock3, X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useState,
} from "react";

import { Button } from "../components/ui/button";
import { FieldError } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { ATTENTION_TONE_CLASS } from "../conversations/ConversationMeta";
import { eventLabel } from "../eventLabel";
import { cn } from "../styles";
import { formatTime } from "../time";
import { useSnoozeResource } from "./inboxSnoozes";
import {
  atLocalHour,
  snoozeChoicesAt,
  type EventSnooze,
  type SnoozeEvents,
} from "./snoozeChoices";

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

/** The panel that the snooze menu shows in place of its times. */
type SnoozePanel = "custom" | "event";

/**
 * Snooze an Inbox row, or every row of a stack, from its action bar: a menu
 * of the snooze times, Custom… for a picked date and time, and Event… for
 * an Event on the subject of the row's items or on a page that the viewer
 * names. Number keys pick the menu rows.
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
  const [panel, setPanel] = useState<SnoozePanel>();
  // Back from a panel focuses its menu row again, so the keys still work.
  const [back, setBack] = useState<SnoozePanel>();
  // The menu reads the clock when it opens: each open renders it again.
  const nowMs = Date.now();
  const choices = snoozeChoicesAt(nowMs);
  const panels: SnoozePanel[] = props.eventSnooze
    ? ["custom", "event"]
    : ["custom"];
  const onKeyDown = (event: KeyboardEvent) => {
    if (panel || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = Number(event.key) - 1;
    if (!Number.isInteger(index) || index < 0) return;
    const choice = choices[index];
    const next = panels[index - choices.length];
    if (choice) props.onSnooze(choice.untilMs(nowMs));
    else if (next) setPanel(next);
    else return;
    event.preventDefault();
  };
  const closePanel = () => {
    setBack(panel);
    setPanel(undefined);
  };
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          setPanel(undefined);
          setBack(undefined);
        }
        props.onOpenChange(open);
      }}
      open={props.open}
    >
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
        // The date and time field needs more room than the times.
        className={cn("grid gap-0.5 p-1", panel ? "w-72" : "w-56")}
        onKeyDown={onKeyDown}
      >
        {panel === "custom" ? (
          <CustomSnooze
            nowMs={nowMs}
            onBack={closePanel}
            onSnooze={props.onSnooze}
          />
        ) : panel === "event" && props.eventSnooze ? (
          <EventSnoozePanel onBack={closePanel} snooze={props.eventSnooze} />
        ) : (
          <>
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
            {panels.map((next, index) => (
              <button
                aria-keyshortcuts={String(choices.length + index + 1)}
                autoFocus={back === next}
                className={MENU_ROW_CLASS}
                key={next}
                onClick={() => setPanel(next)}
                type="button"
              >
                {next === "custom" ? "Custom…" : "Event…"}
              </button>
            ))}
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
  onSnooze(untilMs: number): void;
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
        else props.onSnooze(untilMs);
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

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The Events that the panel offers, and the page that they are on. */
function snoozeTarget(
  url: string,
  subject: SnoozeEvents | undefined,
  named: ReturnType<typeof useSnoozeResource>,
): { error?: string; events?: SnoozeEvents; resourceUrl?: string } {
  switch (named.state) {
    case "empty":
      return { events: subject };
    case "found":
      return { events: named.resource, resourceUrl: url };
    case "invalid":
      return { error: "Paste a link to a pull request or issue." };
    case "loading":
      return {};
    case "unavailable":
      return { error: "You cannot snooze on this link." };
  }
}

/**
 * Pick an Event that ends the snooze, such as a merge of a pull request.
 * The Events are those of the row's subject, or of the pull request or
 * issue that the viewer pastes, so any row can wait on another page. Wake
 * shows the items again then; Dismiss dismisses them, for a viewer who can
 * dismiss each one.
 */
function EventSnoozePanel(props: { onBack(): void; snooze: EventSnooze }) {
  const id = useId();
  const [outcome, setOutcome] = useState<"resolve" | "wake">("wake");
  const [url, setUrl] = useState("");
  const { subject } = props.snooze;
  const named = useSnoozeResource(url.trim());
  const target = snoozeTarget(url.trim(), subject, named);
  const { events } = target;
  return (
    <div className="grid gap-1 p-0.5">
      {props.snooze.resolve ? (
        <ToggleGroup
          aria-label="On the event"
          className="gap-0.5 rounded-lg border border-dashboard-border p-0.5"
          onValueChange={([next]) => {
            if (next) setOutcome(next);
          }}
          value={[outcome]}
        >
          <ToggleGroupItem className="flex-1" value="wake">
            Wake
          </ToggleGroupItem>
          <ToggleGroupItem className="flex-1" value="resolve">
            Dismiss
          </ToggleGroupItem>
        </ToggleGroup>
      ) : null}
      <div className="grid gap-1 px-1.5 pt-1">
        <Label className="text-xs text-muted-foreground" htmlFor={`${id}-url`}>
          Pull request or issue
        </Label>
        <Input
          aria-describedby={target.error ? `${id}-error` : undefined}
          aria-invalid={target.error ? true : undefined}
          autoFocus={!subject}
          id={`${id}-url`}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={
            subject
              ? `This ${subject.resourceType.replaceAll("_", " ")}`
              : "Paste a link"
          }
          type="url"
          value={url}
        />
        <FieldError id={`${id}-error`}>{target.error}</FieldError>
      </div>
      {events ? (
        <div
          aria-label={outcome === "wake" ? "Wake when" : "Dismiss when"}
          className="grid max-h-120 gap-0.5 overflow-y-auto"
          role="group"
        >
          {events.events.map((eventType, index) => (
            <button
              autoFocus={index === 0 && url === ""}
              className={MENU_ROW_CLASS}
              key={eventType}
              onClick={() =>
                props.snooze.onSnooze({
                  eventType,
                  outcome,
                  resourceUrl: target.resourceUrl,
                })
              }
              type="button"
            >
              {sentenceCase(eventLabel(eventType, events.resourceType))}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button onClick={props.onBack} type="button" variant="ghost">
          Back
        </Button>
      </div>
    </div>
  );
}

/**
 * Dismiss an Inbox row. It is quiet like the other actions of its bar, and
 * has no check mark, so it does not read as an answer or an approval.
 */
export function RowDismissButton(props: {
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
 * header: smaller, and only the icon on a narrow screen. `icon`, as a row's
 * quick action: only the icon, with its label as the name and the tooltip.
 */
type ButtonLook = "icon" | "quiet";

const LOOK_CLASSES: Record<ButtonLook, string> = {
  icon: "size-7 p-0",
  quiet: "h-7 gap-1.5 px-2 max-sm:w-7 max-sm:px-0",
};

function ButtonLabel(props: { children: ReactNode; look?: ButtonLook }) {
  if (!props.look) return props.children;
  return (
    <span className={props.look === "icon" ? "sr-only" : "max-sm:sr-only"}>
      {props.children}
    </span>
  );
}
