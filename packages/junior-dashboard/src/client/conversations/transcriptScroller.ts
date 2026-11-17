import { useLocalStorage } from "@uidotdev/usehooks";
import { useSyncExternalStore } from "react";

const SCROLLER_STORAGE_KEY = "junior:transcript:scroller";

/** What a person scrolls a transcript with. */
export type TranscriptScroller = "scrollbar" | "outline";

/**
 * Edit the browser-only choice of what scrolls a transcript. `outline` hides
 * the scrollbar while the conversation outline shows. The scrollbar is the
 * default, so people who do not choose keep it.
 */
export function useTranscriptScroller() {
  return useLocalStorage<TranscriptScroller>(SCROLLER_STORAGE_KEY, "scrollbar");
}

/**
 * Tell whether the person scrolls transcripts with the outline. Unlike
 * `useTranscriptScroller`, this also renders on the server, where it reads
 * the default.
 */
export function useScrollsWithOutline(): boolean {
  return useSyncExternalStore(
    subscribeToStorage,
    scrollsWithOutline,
    () => false,
  );
}

// `useLocalStorage` sends a `storage` event on this window when it writes.
function subscribeToStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function scrollsWithOutline(): boolean {
  try {
    const stored = window.localStorage.getItem(SCROLLER_STORAGE_KEY);
    return stored !== null && JSON.parse(stored) === "outline";
  } catch {
    return false;
  }
}
