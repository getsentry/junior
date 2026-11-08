import { useState, useSyncExternalStore } from "react";
import { DESKTOP_LAYOUT_QUERY } from "../layoutMedia";

const OPEN_KEY = "junior:conversation:sidebar-open";
const WIDTH_KEY = "junior:conversation:sidebar-width";
const DETAILS_WIDTH_KEY = "junior:conversation:details-width";

/** Pixel limits for the conversation list beside a selected conversation. */
export const SIDEBAR_WIDTH = { default: 320, max: 480, min: 240 } as const;

/** Pixel limits for the details panel beside the transcript. */
export const DETAILS_WIDTH = { default: 400, max: 720, min: 320 } as const;

type WidthLimits = { default: number; max: number; min: number };

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
  return readWidth(WIDTH_KEY, SIDEBAR_WIDTH);
}

/** Save the conversation list width without a React render per drag step. */
export function saveSidebarWidth(width: number) {
  writeStorage(WIDTH_KEY, String(Math.round(width)));
}

/** Read the details panel width saved in this browser. */
export function readDetailsWidth(): number {
  return readWidth(DETAILS_WIDTH_KEY, DETAILS_WIDTH);
}

/** Save the details panel width without a React render per drag step. */
export function saveDetailsWidth(width: number) {
  writeStorage(DETAILS_WIDTH_KEY, String(Math.round(width)));
}

function readWidth(key: string, limits: WidthLimits): number {
  const saved = Number(readStorage(key));
  if (!Number.isFinite(saved) || saved <= 0) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, saved));
}

/** Report whether the viewport has room for the list beside the transcript. */
export function useSidebarFits(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(DESKTOP_LAYOUT_QUERY);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DESKTOP_LAYOUT_QUERY).matches,
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
