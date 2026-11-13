import { useSyncExternalStore } from "react";

/**
 * How display text shows links. `rich` shows people with their photo, and a
 * card or thumbnail for a URL alone on its line. `plain` shows every link as
 * titled link text. Both keep the hover card.
 */
export type LinkMode = "plain" | "rich";

const STORAGE_KEY = "junior:links:mode";
const CHANGE_EVENT = "junior:links-mode";

function readLinkMode(): LinkMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "plain"
      ? "plain"
      : "rich";
  } catch {
    return "rich";
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function saveLinkMode(mode: LinkMode): void {
  try {
    if (mode === "rich") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage is blocked, so links stay rich.
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Read and update this browser's link mode. */
export function useLinkModeChoice(): [LinkMode, (mode: LinkMode) => void] {
  // Server renders have no browser storage, so they show rich links.
  const mode = useSyncExternalStore<LinkMode>(
    subscribe,
    readLinkMode,
    () => "rich",
  );
  return [mode, saveLinkMode];
}

/** Tell whether this browser shows every link as plain link text. */
export function usePlainLinks(): boolean {
  return useLinkModeChoice()[0] === "plain";
}
