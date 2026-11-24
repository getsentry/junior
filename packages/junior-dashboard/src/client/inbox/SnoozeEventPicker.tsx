import { ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { selectTriggerClass } from "../components/ui/select";
import { eventLabel } from "../eventLabel";
import { cn } from "../styles";
import { fadeTextClass } from "../textFade";
import type { SnoozeEvents } from "./snoozeChoices";
import { sentenceCase } from "./snoozeSentences";

/** How an Event reads after its page's name, such as "is merged". */
function eventPhrase(eventType: string, events: SnoozeEvents): string {
  return (
    events.phrases[eventType] ??
    sentenceCase(eventLabel(eventType, events.resourceType))
  );
}

interface EventGroup {
  events: string[];
  /** The shared first part of the Event names. The loose Events have none. */
  heading?: string;
  key: string;
}

/**
 * Group Events by the first part of their name after the resource type,
 * such as `pull_request.review.*`. A part that only one Event has makes no
 * group, so those Events stay loose at the top. Groups keep the order of
 * their first Event in the catalog.
 */
function groupEvents(events: SnoozeEvents): EventGroup[] {
  const prefix = `${events.resourceType}.`;
  const partOf = (eventType: string) =>
    (eventType.startsWith(prefix)
      ? eventType.slice(prefix.length)
      : eventType
    ).split(".")[0] ?? eventType;
  const counts = new Map<string, number>();
  for (const eventType of events.events) {
    const part = partOf(eventType);
    counts.set(part, (counts.get(part) ?? 0) + 1);
  }
  const loose: EventGroup = { events: [], key: "" };
  const groups = new Map<string, EventGroup>();
  for (const eventType of events.events) {
    const part = partOf(eventType);
    if ((counts.get(part) ?? 0) < 2) {
      loose.events.push(eventType);
      continue;
    }
    const group = groups.get(part) ?? {
      events: [],
      heading: sentenceCase(part.replaceAll("_", " ")),
      key: part,
    };
    group.events.push(eventType);
    groups.set(part, group);
  }
  return [loose, ...groups.values()].filter((group) => group.events.length > 0);
}

// Words of an Event name or phrase, so "merge conflict" finds
// `pull_request.merge_conflict.resolved`.
const words = (text: string) => text.toLowerCase().replaceAll(/[._]/g, " ");

// Match the typed text inside an Event's name or phrase, in the catalog
// order, not by fuzzy score.
function matchEvent(value: string, search: string, keywords?: string[]) {
  return words([value, ...(keywords ?? [])].join(" ")).includes(
    words(search).trim(),
  )
    ? 1
    : 0;
}

/**
 * The Event of one condition. The list filters as the viewer types and
 * groups the page's Events by name, so a long list of pull request Events
 * stays easy to scan.
 */
export function SnoozeEventPicker(props: {
  events: SnoozeEvents | undefined;
  onPick(eventType: string): void;
  /** The text while there is no Event, such as while the page loads. */
  placeholder: string;
  value: string | undefined;
}) {
  const { events, value } = props;
  const [open, setOpen] = useState(false);
  const popupId = useId();
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-controls={open ? popupId : undefined}
        aria-label="Event"
        className={cn(selectTriggerClass, "row-start-2 min-w-0 sm:flex-1")}
        disabled={!events}
        role="combobox"
      >
        <span className={cn(fadeTextClass, "flex-1 text-left")}>
          {value && events ? eventPhrase(value, events) : props.placeholder}
        </span>
        <ChevronDownIcon aria-hidden="true" className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--anchor-width) max-w-[calc(100vw-2rem)] min-w-64 overflow-hidden p-0"
        id={popupId}
      >
        {events ? (
          <Command defaultValue={value} filter={matchEvent} label="Events" loop>
            <CommandInput autoFocus placeholder="Filter events" />
            <CommandList className="max-h-64" label="Events">
              {groupEvents(events).map((group) => (
                <CommandGroup
                  heading={group.heading}
                  key={group.key}
                  value={group.key}
                >
                  {group.events.map((eventType) => (
                    <CommandItem
                      key={eventType}
                      keywords={[eventPhrase(eventType, events)]}
                      onSelect={() => {
                        props.onPick(eventType);
                        setOpen(false);
                      }}
                      value={eventType}
                    >
                      {eventPhrase(eventType, events)}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
              <CommandEmpty>No events match.</CommandEmpty>
            </CommandList>
          </Command>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
