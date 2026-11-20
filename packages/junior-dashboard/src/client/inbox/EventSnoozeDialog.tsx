import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  codeChangeSearchReportSchema,
  type InboxSnoozeTrigger,
} from "@sentry/junior/api/schema";
import { Link2 } from "lucide-react";
import { type RefObject, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { FieldError } from "../components/ui/field";
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
import type { EventSnooze, SnoozeEvents } from "./snoozeChoices";

// Like the composer's `#` menu: a person who types waits for the next key.
const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_STALE_MS = 60_000;
// The longest query that the code change search takes.
const SEARCH_MAX_LENGTH = 100;

const EVENT_ROW_CLASS =
  "flex cursor-pointer items-baseline rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left font-sans text-sm text-dashboard-text hover:bg-dashboard-fill-hover focus-visible:bg-dashboard-fill-hover focus-visible:outline-none";

/**
 * The page whose Events end the snooze: the subject of the row's items, or
 * a pull request or issue that the viewer picks or pastes.
 */
type Watched =
  | { kind: "subject" }
  | { kind: "page"; reference?: ComposerReference; url: string };

/**
 * Snooze a row until an Event, in a dialog: first pick the page to watch,
 * from the row's subject, a search of pull requests, or a pasted link; then
 * pick its Event. Wake shows the items again then; Dismiss dismisses them,
 * for a viewer who can dismiss each one.
 */
export function EventSnoozeDialog(props: {
  onClose(): void;
  snooze: EventSnooze;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const sheet = useSheet(props.onClose, inputRef);
  const [watched, setWatched] = useState<Watched>();
  return (
    <Dialog {...sheet.rootProps}>
      <DialogContent
        {...sheet.contentProps}
        className="flex max-w-lg flex-col gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="px-4 pt-4 pb-2 text-base">
          Snooze until an event
        </DialogTitle>
        {watched ? (
          <EventPicker
            onBack={() => setWatched(undefined)}
            onPick={(trigger) => {
              props.snooze.onSnooze(trigger);
              sheet.close();
            }}
            snooze={props.snooze}
            watched={watched}
          />
        ) : (
          <WatchPicker
            inputRef={inputRef}
            onPick={setWatched}
            subject={props.snooze.subject}
          />
        )}
      </DialogContent>
    </Dialog>
  );
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
  inputRef: RefObject<HTMLInputElement | null>;
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
        onValueChange={setQuery}
        placeholder="Search pull requests or paste a link"
        ref={props.inputRef}
        value={query}
      />
      <CommandList>
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

/** Pick the Event of the watched page that ends the snooze. */
function EventPicker(props: {
  onBack(): void;
  onPick(trigger: InboxSnoozeTrigger): void;
  snooze: EventSnooze;
  watched: Watched;
}) {
  const [outcome, setOutcome] = useState<"resolve" | "wake">("wake");
  const { subject } = props.snooze;
  const { watched } = props;
  const url = watched.kind === "page" ? watched.url : "";
  const named = useSnoozeResource(url);
  const { error, events } = watchedEvents(watched, subject, named);
  return (
    <div className="grid gap-2 px-3 pb-3">
      <div className="flex min-w-0 items-center gap-2 px-1">
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
        <Button onClick={props.onBack} type="button" variant="ghost">
          Change
        </Button>
      </div>
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
      {error ? <FieldError className="px-1">{error}</FieldError> : null}
      {!error && !events ? (
        <p className="m-0 px-1 font-sans text-sm text-muted-foreground">
          Checking the link…
        </p>
      ) : null}
      {events ? (
        <div
          aria-label={outcome === "wake" ? "Wake when" : "Dismiss when"}
          className="grid max-h-[min(24rem,50dvh)] gap-0.5 overflow-y-auto"
          role="group"
        >
          {events.events.map((eventType, index) => (
            <button
              autoFocus={index === 0}
              className={EVENT_ROW_CLASS}
              key={eventType}
              onClick={() =>
                props.onPick({
                  eventType,
                  outcome,
                  resourceUrl:
                    watched.kind === "page" ? watched.url : undefined,
                })
              }
              type="button"
            >
              {sentenceCase(eventLabel(eventType, events.resourceType))}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
