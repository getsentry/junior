import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  codeChangeSearchReportSchema,
  INBOX_SNOOZE_MAX_TRIGGERS,
} from "@sentry/junior/api/schema";
import { ChevronsUpDown, Link2, Plus, X } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../components/ui/dialog";
import { FieldError } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { useSheet } from "../components/ui/useSheet";
import {
  ReferenceIcon,
  referenceName,
} from "../conversations/ComposerReference";
import type { ComposerReference } from "../conversations/composerReferences";
import { useDebouncedValue } from "../debouncedValue";
import { eventLabel } from "../eventLabel";
import { fetchDashboardJson } from "../http";
import { cn } from "../styles";
import { fadeTextClass } from "../textFade";
import { useSnoozeResource } from "./inboxSnoozes";
import { eventSentence, sentenceCase } from "./snoozeSentences";
import {
  SOMEDAY,
  type CustomSnoozeEnd,
  type EventSnooze,
  type SnoozeEvents,
} from "./snoozeChoices";

// Like the composer's `#` menu: a person who types waits for the next key.
const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_STALE_MS = 60_000;
// The longest query that the code change search takes.
const SEARCH_MAX_LENGTH = 100;

/**
 * The page whose Events end the snooze: the subject of the row's items, or
 * a pull request or issue that the viewer picks or pastes.
 */
type Watched =
  | { kind: "subject" }
  | { kind: "page"; reference?: ComposerReference; url: string };

/** One condition: an Event on a page. Either part can still be unpicked. */
interface Condition {
  eventType?: string;
  id: number;
  watched?: Watched;
}

/** A condition that names a page and an Event, ready to post. */
interface CompleteCondition {
  eventType: string;
  watched: Watched;
}

/**
 * A custom snooze, in a dialog: a date and time, conditions, or both, and
 * the first of them ends the snooze. Each condition is one Event on a page:
 * the subject of the row's items, a pull request that the search finds, or
 * a pasted link to a pull request or issue. Wake shows the items again
 * then; Dismiss dismisses them, for a viewer who can dismiss each one. The
 * time always wakes them. Someday snoozes with neither, until the items
 * close.
 */
export function SnoozeDialog(props: {
  /** Set when the row can snooze until an Event. */
  events: EventSnooze | undefined;
  nowMs: number;
  onClose(): void;
  onSnooze(end: CustomSnoozeEnd): void;
}) {
  const id = useId();
  const timeRef = useRef<HTMLInputElement>(null);
  const sheet = useSheet(props.onClose, timeRef);
  const [time, setTime] = useState("");
  const [outcome, setOutcome] = useState<"resolve" | "wake">("wake");
  const [conditions, setConditions] = useState<readonly Condition[]>([]);
  const nextId = useRef(0);
  // The time field is wrong, or nothing ends the snooze.
  const [error, setError] = useState<{ message: string; time: boolean }>();
  const subject = props.events?.subject;
  const add = () => {
    nextId.current += 1;
    setConditions([
      ...conditions,
      {
        id: nextId.current,
        watched: subject ? { kind: "subject" } : undefined,
      },
    ]);
    setError(undefined);
  };
  const change = (next: Condition) => {
    setConditions(conditions.map((row) => (row.id === next.id ? next : row)));
    setError(undefined);
  };
  const remove = (rowId: number) => {
    setConditions(conditions.filter((row) => row.id !== rowId));
    setError(undefined);
  };
  const submit = () => {
    // A `datetime-local` value has no offset, so it parses as local time.
    const untilMs = time ? new Date(time).getTime() : undefined;
    // A row offers only the Events of a page that the viewer can snooze
    // on, so a picked Event is one of them.
    const complete = conditions.flatMap(({ eventType, watched }) =>
      eventType && watched ? [{ eventType, watched }] : [],
    );
    if (untilMs !== undefined && Number.isNaN(untilMs)) {
      setError({ message: "Pick a date and time.", time: true });
    } else if (untilMs !== undefined && untilMs <= Date.now()) {
      setError({ message: "Pick a time in the future.", time: true });
    } else if (complete.length < conditions.length) {
      setError({
        message: "Finish each condition, or remove it.",
        time: false,
      });
    } else if (untilMs === undefined && complete.length === 0) {
      setError({ message: "Pick a time or an event.", time: false });
    } else {
      props.onSnooze({ triggers: snoozeTriggers(complete, outcome), untilMs });
      sheet.close();
    }
  };
  return (
    <Dialog {...sheet.rootProps}>
      <DialogContent
        {...sheet.contentProps}
        // Pinned to the top, the dialog grows down as conditions are added
        // instead of moving to stay centered, and stops above the bottom.
        className="flex max-h-[min(40rem,90dvh)] max-w-lg flex-col gap-3 overflow-hidden p-4 sm:top-[15dvh] sm:max-h-[min(40rem,80dvh)] sm:translate-y-0"
      >
        <DialogTitle className="text-base">Custom snooze</DialogTitle>
        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground" htmlFor={`${id}-at`}>
            Wake at
          </Label>
          <Input
            aria-describedby={error?.time ? `${id}-error` : undefined}
            aria-invalid={error?.time ? true : undefined}
            id={`${id}-at`}
            min={localInputValue(props.nowMs)}
            onChange={(event) => {
              setTime(event.target.value);
              setError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submit();
            }}
            ref={timeRef}
            size="comfortable"
            type="datetime-local"
            value={time}
          />
        </div>
        {props.events ? (
          <section
            aria-labelledby={`${id}-events`}
            className="flex min-h-0 flex-col gap-1.5"
          >
            <div className="flex min-h-8 items-center justify-between gap-2">
              <h3
                className="m-0 text-xs font-normal text-muted-foreground"
                id={`${id}-events`}
              >
                Or when any of these happens
              </h3>
              {props.events.resolve && conditions.length > 0 ? (
                <ToggleGroup
                  aria-label="On the event"
                  className="gap-0.5 rounded-lg border border-dashboard-border p-0.5"
                  onValueChange={([next]) => {
                    if (next) setOutcome(next);
                  }}
                  value={[outcome]}
                >
                  <ToggleGroupItem value="wake">Wake</ToggleGroupItem>
                  <ToggleGroupItem value="resolve">Dismiss</ToggleGroupItem>
                </ToggleGroup>
              ) : null}
            </div>
            {conditions.length > 0 ? (
              <div className="grid min-h-0 gap-1.5 overflow-y-auto">
                {conditions.map((row) => (
                  <ConditionRow
                    condition={row}
                    key={row.id}
                    onChange={change}
                    onRemove={() => remove(row.id)}
                    subject={subject}
                  />
                ))}
              </div>
            ) : null}
            {conditions.length < INBOX_SNOOZE_MAX_TRIGGERS ? (
              <Button
                className="self-start"
                onClick={add}
                type="button"
                variant="ghost"
              >
                <Plus aria-hidden="true" />
                Add condition
              </Button>
            ) : null}
          </section>
        ) : null}
        <FieldError id={`${id}-error`}>{error?.message}</FieldError>
        <DialogFooter className="flex justify-end gap-1">
          {props.events ? (
            <Button
              className="sm:mr-auto"
              onClick={() => {
                props.onSnooze(SOMEDAY);
                sheet.close();
              }}
              type="button"
              variant="ghost"
            >
              Someday
            </Button>
          ) : null}
          <Button onClick={sheet.close} type="button" variant="ghost">
            Cancel
          </Button>
          <Button onClick={submit} type="button" variant="outline">
            Snooze
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One trigger for each distinct condition, with the outcome of them all. */
function snoozeTriggers(
  conditions: readonly CompleteCondition[],
  outcome: "resolve" | "wake",
): CustomSnoozeEnd["triggers"] {
  const seen = new Set<string>();
  return conditions.flatMap(({ eventType, watched }) => {
    const resourceUrl = watched.kind === "page" ? watched.url : undefined;
    const key = `${resourceUrl ?? ""} ${eventType}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ eventType, outcome, resourceUrl }];
  });
}

/** The `datetime-local` value of a time, in the browser's timezone. */
function localInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "This pull request", for a row's subject of that resource type. */
function subjectName(subject: SnoozeEvents): string {
  return `This ${subject.resourceType.replaceAll("_", " ")}`;
}

/** Pull requests that Junior tracks, by number, title, or repository. */
function useCodeChangeSearch(query: string) {
  const debounced = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const search = useQuery({
    enabled: debounced.length > 0,
    placeholderData: keepPreviousData,
    // The composer's `#` menu reads the same search.
    queryKey: ["dashboard", "code", "changes", "search", debounced],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        codeChangeSearchReportSchema,
        `/api/code/changes/search?${new URLSearchParams({ q: debounced })}`,
        signal,
      ),
    staleTime: SEARCH_STALE_MS,
  });
  if (!query) return { changes: [], searching: false };
  return {
    changes: search.data?.changes ?? [],
    searching: debounced !== query || search.isFetching,
  };
}

/**
 * Pick the page to watch: the row's subject, a pull request that the
 * search finds, or a pasted link to a pull request or issue.
 */
function WatchPicker(props: {
  onPick(watched: Watched): void;
  subject: SnoozeEvents | undefined;
}) {
  const [query, setQuery] = useState("");
  const text = query.trim();
  const link = URL.canParse(text) ? text : undefined;
  const search = useCodeChangeSearch(
    link ? "" : text.slice(0, SEARCH_MAX_LENGTH),
  );
  return (
    <Command label="Pull request or issue" shouldFilter={false}>
      <CommandInput
        autoFocus
        onValueChange={setQuery}
        placeholder="Search pull requests or paste a link"
        value={query}
      />
      <CommandList className="max-h-64">
        {props.subject && !text ? (
          <CommandGroup heading="This item">
            <CommandItem
              onSelect={() => props.onPick({ kind: "subject" })}
              value="subject"
            >
              {subjectName(props.subject)}
            </CommandItem>
          </CommandGroup>
        ) : null}
        {link ? (
          <CommandGroup heading="Link">
            <CommandItem
              onSelect={() => props.onPick({ kind: "page", url: link })}
              value={link}
            >
              <Link2 aria-hidden="true" />
              <span className={fadeTextClass}>{link}</span>
            </CommandItem>
          </CommandGroup>
        ) : null}
        {search.changes.length > 0 ? (
          <CommandGroup heading="Pull requests">
            {search.changes.map((change) => {
              const reference: ComposerReference = {
                draft: change.draft,
                kind: "code_change",
                number: change.number,
                repository: change.repository,
                state: change.state,
                url: change.url,
              };
              return (
                <CommandItem
                  key={change.url}
                  onSelect={() =>
                    props.onPick({ kind: "page", reference, url: change.url })
                  }
                  value={change.url}
                >
                  <ReferenceIcon reference={reference} />
                  <span className="shrink-0">{referenceName(reference)}</span>
                  <span className={cn(fadeTextClass, "text-muted-foreground")}>
                    {change.title}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        <CommandEmpty>
          {!text
            ? "Search pull requests, or paste a link to a pull request or issue."
            : search.searching
              ? "Searching…"
              : "No pull requests match. Paste a link to a pull request or issue."}
        </CommandEmpty>
      </CommandList>
    </Command>
  );
}

/** The Events of the watched page, or why it has none. */
function watchedEvents(
  watched: Watched,
  subject: SnoozeEvents | undefined,
  named: ReturnType<typeof useSnoozeResource>,
): { error?: string; events?: SnoozeEvents } {
  if (watched.kind === "subject") return { events: subject };
  switch (named.state) {
    case "found":
      return { events: named.resource };
    case "empty":
    case "loading":
      return {};
    case "invalid":
    case "unavailable":
      return { error: "You cannot snooze on this link." };
  }
}

/**
 * One condition: a page and one of its Events. A new row with no page opens
 * the search at once. The search floats over the dialog, and the Event
 * select keeps its size while the page loads, so the dialog does not jump.
 */
function ConditionRow(props: {
  condition: Condition;
  onChange(next: Condition): void;
  onRemove(): void;
  subject: SnoozeEvents | undefined;
}) {
  const { condition, subject } = props;
  const { watched } = condition;
  const [open, setOpen] = useState(!watched);
  const named = useSnoozeResource(watched?.kind === "page" ? watched.url : "");
  const { error, events } = watched
    ? watchedEvents(watched, subject, named)
    : {};
  const name = watched && events && watchedName(watched, events.resourceType);
  return (
    <div className="grid gap-1">
      <div
        aria-label={
          name && events && condition.eventType
            ? eventSentence(condition.eventType, events, name)
            : "New condition"
        }
        // A phone puts the Event under the page, so both names fit.
        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 sm:flex"
        role="group"
      >
        <Popover onOpenChange={setOpen} open={open}>
          <PopoverTrigger className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-panel px-2.5 text-left font-sans text-xs font-medium text-dashboard-text hover:border-dashboard-border-interactive focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus md:h-8">
            {watched?.kind === "page" && watched.reference ? (
              <ReferenceIcon reference={watched.reference} />
            ) : null}
            <span
              className={cn(
                fadeTextClass,
                "flex-1",
                !watched && "text-dashboard-text-muted",
              )}
            >
              {watched
                ? pageName(watched, subject)
                : "Pick a pull request or issue"}
            </span>
            <ChevronsUpDown
              aria-hidden="true"
              className="size-3.5 shrink-0 text-dashboard-text-muted"
            />
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-(--anchor-width) max-w-[calc(100vw-2rem)] min-w-80 overflow-hidden p-0"
          >
            <WatchPicker
              onPick={(next) => {
                props.onChange({ id: condition.id, watched: next });
                setOpen(false);
              }}
              subject={subject}
            />
          </PopoverContent>
        </Popover>
        <Select<string>
          disabled={!events}
          onValueChange={(next) => {
            if (next) props.onChange({ ...condition, eventType: next });
          }}
          value={condition.eventType ?? null}
        >
          <SelectTrigger
            aria-label="Event"
            className="row-start-2 min-w-0 sm:flex-1"
          >
            <SelectValue className={cn(fadeTextClass, "flex-1 text-left")}>
              {(value: string | null) =>
                value && events
                  ? eventPhrase(value, events)
                  : watched && !events && !error
                    ? "Checking the link…"
                    : "Pick an event"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {events?.events.map((eventType) => (
              <SelectItem key={eventType} value={eventType}>
                {eventPhrase(eventType, events)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          aria-label="Remove condition"
          className="col-start-2 row-start-1"
          onClick={props.onRemove}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

/** The name of a picked page on its row's button. */
function pageName(watched: Watched, subject: SnoozeEvents | undefined) {
  if (watched.kind === "subject") return subject && subjectName(subject);
  return watched.reference ? referenceName(watched.reference) : watched.url;
}

/** How an Event reads after its page's name, such as "is merged". */
function eventPhrase(eventType: string, events: SnoozeEvents): string {
  return (
    events.phrases[eventType] ??
    sentenceCase(eventLabel(eventType, events.resourceType))
  );
}

/**
 * What the Event sentences call the watched page: "this pull request", a
 * pull request that the search found by name, or "the issue" of a link.
 */
function watchedName(watched: Watched, resourceType: string): string {
  const type = resourceType.replaceAll("_", " ");
  if (watched.kind === "subject") return `this ${type}`;
  return watched.reference ? referenceName(watched.reference) : `the ${type}`;
}
