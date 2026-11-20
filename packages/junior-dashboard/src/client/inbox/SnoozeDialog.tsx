import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { codeChangeSearchReportSchema } from "@sentry/junior/api/schema";
import { Link2 } from "lucide-react";
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
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../components/ui/dialog";
import { FieldError } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
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
import type {
  CustomSnoozeEnd,
  EventSnooze,
  SnoozeEvents,
} from "./snoozeChoices";

// Like the composer's `#` menu: a person who types waits for the next key.
const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_STALE_MS = 60_000;
// The longest query that the code change search takes.
const SEARCH_MAX_LENGTH = 100;

const EVENT_ROW_CLASS =
  "flex cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left font-sans text-sm text-dashboard-text hover:bg-dashboard-fill-hover focus-visible:bg-dashboard-fill-hover focus-visible:outline-none";

/**
 * The page whose Events end the snooze: the subject of the row's items, or
 * a pull request or issue that the viewer picks or pastes.
 */
type Watched =
  | { kind: "subject" }
  | { kind: "page"; reference?: ComposerReference; url: string };

/**
 * A custom snooze, in a dialog: a date and time, Events of a page, or
 * both, and the first of them ends the snooze. The page is the subject of
 * the row's items, a pull request that the search finds, or a pasted link
 * to a pull request or issue. Wake shows the items again then; Dismiss
 * dismisses them, for a viewer who can dismiss each one. The time always
 * wakes them.
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
  const [watched, setWatched] = useState<Watched | undefined>(() =>
    props.events?.subject ? { kind: "subject" } : undefined,
  );
  // Change shows the search again, which then takes the keys.
  const [searchFocus, setSearchFocus] = useState(false);
  const [outcome, setOutcome] = useState<"resolve" | "wake">("wake");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  // The time field is wrong, or nothing ends the snooze.
  const [error, setError] = useState<{ message: string; time: boolean }>();
  const url = watched?.kind === "page" ? watched.url : "";
  const named = useSnoozeResource(url);
  const watch = (next: Watched | undefined) => {
    setWatched(next);
    setPicked(new Set());
    setError(undefined);
  };
  const submit = () => {
    // A `datetime-local` value has no offset, so it parses as local time.
    const untilMs = time ? new Date(time).getTime() : undefined;
    if (untilMs !== undefined && Number.isNaN(untilMs)) {
      setError({ message: "Pick a date and time.", time: true });
    } else if (untilMs !== undefined && untilMs <= Date.now()) {
      setError({ message: "Pick a time in the future.", time: true });
    } else if (untilMs === undefined && picked.size === 0) {
      setError({ message: "Pick a time or an event.", time: false });
    } else {
      props.onSnooze({
        triggers: [...picked].map((eventType) => ({
          eventType,
          outcome,
          resourceUrl: watched?.kind === "page" ? watched.url : undefined,
        })),
        untilMs,
      });
      sheet.close();
    }
  };
  return (
    <Dialog {...sheet.rootProps}>
      <DialogContent
        {...sheet.contentProps}
        className="flex max-h-[min(40rem,90dvh)] max-w-lg flex-col gap-3 overflow-hidden p-4"
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
            <h3
              className="m-0 text-xs font-normal text-muted-foreground"
              id={`${id}-events`}
            >
              Or on an event
            </h3>
            {watched ? (
              <EventPicker
                named={named}
                onChange={() => {
                  watch(undefined);
                  setSearchFocus(true);
                }}
                onOutcome={setOutcome}
                onPicked={(next) => {
                  setPicked(next);
                  setError(undefined);
                }}
                outcome={outcome}
                picked={picked}
                snooze={props.events}
                watched={watched}
              />
            ) : (
              <WatchPicker
                autoFocus={searchFocus}
                onPick={watch}
                subject={props.events.subject}
              />
            )}
          </section>
        ) : null}
        <FieldError id={`${id}-error`}>{error?.message}</FieldError>
        <DialogFooter className="flex justify-end gap-1">
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
  autoFocus: boolean;
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
        autoFocus={props.autoFocus}
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

/** Pick the Events of the watched page that end the snooze. */
function EventPicker(props: {
  named: ReturnType<typeof useSnoozeResource>;
  onChange(): void;
  onOutcome(outcome: "resolve" | "wake"): void;
  onPicked(picked: ReadonlySet<string>): void;
  outcome: "resolve" | "wake";
  picked: ReadonlySet<string>;
  snooze: EventSnooze;
  watched: Watched;
}) {
  const { subject } = props.snooze;
  const { watched } = props;
  const { error, events } = watchedEvents(watched, subject, props.named);
  const toggle = (eventType: string, on: boolean) => {
    const next = new Set(props.picked);
    if (on) next.add(eventType);
    else next.delete(eventType);
    props.onPicked(next);
  };
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {watched.kind === "page" && watched.reference ? (
          <ReferenceIcon reference={watched.reference} />
        ) : null}
        <span
          className={cn(
            fadeTextClass,
            "flex-1 font-sans text-sm text-dashboard-text",
          )}
        >
          {watched.kind === "subject"
            ? subject && subjectName(subject)
            : watched.reference
              ? referenceName(watched.reference)
              : watched.url}
        </span>
        <Button onClick={props.onChange} type="button" variant="ghost">
          Change
        </Button>
      </div>
      {props.snooze.resolve ? (
        <ToggleGroup
          aria-label="On the event"
          className="gap-0.5 rounded-lg border border-dashboard-border p-0.5"
          onValueChange={([next]) => {
            if (next) props.onOutcome(next);
          }}
          value={[props.outcome]}
        >
          <ToggleGroupItem className="flex-1" value="wake">
            Wake
          </ToggleGroupItem>
          <ToggleGroupItem className="flex-1" value="resolve">
            Dismiss
          </ToggleGroupItem>
        </ToggleGroup>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
      {!error && !events ? (
        <p className="m-0 font-sans text-sm text-muted-foreground">
          Checking the link…
        </p>
      ) : null}
      {events ? (
        <div
          aria-label={props.outcome === "wake" ? "Wake when" : "Dismiss when"}
          className="grid min-h-0 gap-0.5 overflow-y-auto"
          role="group"
        >
          {events.events.map((eventType) => (
            <label className={EVENT_ROW_CLASS} key={eventType}>
              <Checkbox
                checked={props.picked.has(eventType)}
                onCheckedChange={(on) => toggle(eventType, on)}
              />
              {eventSentence(
                eventType,
                events,
                watchedName(watched, events.resourceType),
              )}
            </label>
          ))}
        </div>
      ) : null}
    </>
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

/**
 * An Event as a sentence about the page, such as "When getsentry/junior#12
 * is merged", from the phrase of the Event's source. An Event without one
 * reads as its label on the page.
 */
function eventSentence(
  eventType: string,
  events: SnoozeEvents,
  name: string,
): string {
  const phrase = events.phrases[eventType];
  return phrase
    ? `When ${name} ${phrase}`
    : `${sentenceCase(eventLabel(eventType, events.resourceType))} on ${name}`;
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
