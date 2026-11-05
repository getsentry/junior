import { useState, useSyncExternalStore } from "react";

const OPEN_KEY = "junior:conversation:sidebar-open";
const WIDTH_KEY = "junior:conversation:sidebar-width";
const WIDE_QUERY = "(min-width: 768px)";

/** Pixel limits for the conversation list beside a selected conversation. */
export const SIDEBAR_WIDTH = { default: 320, max: 480, min: 240 } as const;

/** Remember whether the conversation list is open in this browser. */
export function useConversationSidebarOpen() {
  const [open, setOpen] = useState(() => readStorage(OPEN_KEY) !== "false");

  function updateOpen(next: boolean) {
    setOpen(next);
    writeStorage(OPEN_KEY, String(next));
  }

  return [open, updateOpen] as const;
}

/** Read the conversation list width saved in this browser. */
export function readSidebarWidth(): number {
  const saved = Number(readStorage(WIDTH_KEY));
  if (!Number.isFinite(saved) || saved <= 0) return SIDEBAR_WIDTH.default;
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, saved));
}

/** Save the conversation list width without a React render per drag step. */
export function saveSidebarWidth(width: number) {
  writeStorage(WIDTH_KEY, String(Math.round(width)));
}

/** Report whether the viewport has room for the list beside the transcript. */
export function useSidebarFits(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(WIDE_QUERY);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The layout still works for this page when browser storage is unavailable.
  }
}
