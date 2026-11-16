import { useSyncExternalStore } from "react";

const FULL_WIDTH_KEY = "junior:conversation:full-width";
const FULL_WIDTH_CHANGE_EVENT = "junior:conversation:full-width-change";

function readFullWidth(): boolean {
  try {
    return window.localStorage.getItem(FULL_WIDTH_KEY) === "true";
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(FULL_WIDTH_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(FULL_WIDTH_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function saveFullWidth(full: boolean): void {
  try {
    if (full) {
      window.localStorage.setItem(FULL_WIDTH_KEY, "true");
    } else {
      window.localStorage.removeItem(FULL_WIDTH_KEY);
    }
  } catch {
    // Storage is blocked, so the transcript keeps its fixed width.
    return;
  }
  window.dispatchEvent(new Event(FULL_WIDTH_CHANGE_EVENT));
}

/**
 * Read and update whether conversation transcripts fill the pane width in
 * this browser. Off by default, so lines keep a readable length.
 */
export function useTranscriptFullWidth(): [boolean, (full: boolean) => void] {
  const full = useSyncExternalStore(subscribe, readFullWidth, () => false);
  return [full, saveFullWidth];
}
