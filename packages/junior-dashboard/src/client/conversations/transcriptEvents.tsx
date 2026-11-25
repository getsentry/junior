import { useSyncExternalStore } from "react";
import { Hand, List } from "lucide-react";

import {
  PreferenceToggle,
  type PreferenceChoice,
} from "../components/PreferenceToggle";

/**
 * Which Watch Events a transcript shows as rows. `needs_you` folds routine
 * ones into activity; `all` shows each one.
 */
type TranscriptEvents = "all" | "needs_you";

const EVENTS_STORAGE_KEY = "junior:transcript-events";
const EVENTS_CHANGE_EVENT = "junior:transcript-events-change";

function readEvents(): TranscriptEvents {
  try {
    return window.localStorage.getItem(EVENTS_STORAGE_KEY) === "all"
      ? "all"
      : "needs_you";
  } catch {
    return "needs_you";
  }
}

function subscribeEvents(onChange: () => void): () => void {
  window.addEventListener(EVENTS_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENTS_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function saveEvents(events: TranscriptEvents): void {
  try {
    window.localStorage.setItem(EVENTS_STORAGE_KEY, events);
  } catch {
    // Storage is blocked, so routine Events stay folded.
    return;
  }
  window.dispatchEvent(new Event(EVENTS_CHANGE_EVENT));
}

/** Which Watch Events the viewer chose to see, kept in this browser. */
export function useTranscriptEvents(): TranscriptEvents {
  return useSyncExternalStore(
    subscribeEvents,
    readEvents,
    () => "needs_you" as const,
  );
}

const eventChoices = [
  { Icon: Hand, label: "Needs you", value: "needs_you" },
  { Icon: List, label: "All", value: "all" },
] as const satisfies ReadonlyArray<PreferenceChoice<TranscriptEvents>>;

/** Choose which Watch Events show as transcript rows, next to density. */
export function TranscriptEventsSwitcher(props: {
  className?: string;
  menu?: boolean;
}) {
  const events = useTranscriptEvents();
  return (
    <PreferenceToggle<TranscriptEvents>
      choices={eventChoices}
      className={props.className}
      itemLabel={(item) => `${item.label} events`}
      menu={props.menu}
      label="Events"
      onChange={saveEvents}
      value={events}
    />
  );
}
