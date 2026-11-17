import { useLocalStorage } from "@uidotdev/usehooks";

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
