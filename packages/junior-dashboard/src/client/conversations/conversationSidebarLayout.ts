import { useState, useSyncExternalStore } from "react";
import type { RemSize } from "../components/ui/resizable";
import { DESKTOP_LAYOUT_QUERY } from "../layoutMedia";

import { hasPanelSpace } from "../components/DetailsPanel";

const OPEN_KEY = "junior:conversation:sidebar-open";
const DETAILS_OPEN_KEY = "junior:conversation:details-open";
// Widths are in rem, so panels keep room for their text when the reader
// changes the browser font size. The keys name the unit, so a width saved in
// px before is not read as rem.
const WIDTH_KEY = "junior:conversation:sidebar-width-rem";
const DETAILS_WIDTH_KEY = "junior:conversation:details-width-rem";

/** Rem limits for the conversation list beside a selected conversation. */
export const SIDEBAR_WIDTH = { default: 20, max: 30, min: 15 } as const;

/** Rem limits for the details panel beside the transcript. */
export const DETAILS_WIDTH = { default: 25, max: 45, min: 20 } as const;

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

/** Read whether the reader left details open in this browser, if they chose. */
export function readDetailsOpen(): boolean | undefined {
  const value = readStorage(DETAILS_OPEN_KEY);
  return value === null ? undefined : value === "true";
}

/**
 * Save whether the reader keeps details open. A bottom sheet on a narrow
 * screen is a one-off, so only a panel beside the transcript saves.
 */
export function saveDetailsOpen(open: boolean) {
  if (hasPanelSpace()) writeStorage(DETAILS_OPEN_KEY, String(open));
}

/** Read the conversation list width saved in this browser. */
export function readSidebarWidth(): RemSize {
  return readWidth(WIDTH_KEY, SIDEBAR_WIDTH);
}

/** Save the conversation list width in px without a React render per drag step. */
export function saveSidebarWidth(px: number) {
  writeWidth(WIDTH_KEY, px);
}

/** Read the details panel width saved in this browser. */
export function readDetailsWidth(): RemSize {
  return readWidth(DETAILS_WIDTH_KEY, DETAILS_WIDTH);
}

/** Save the details panel width in px without a React render per drag step. */
export function saveDetailsWidth(px: number) {
  writeWidth(DETAILS_WIDTH_KEY, px);
}

function readWidth(key: string, limits: WidthLimits): RemSize {
  const saved = Number(readStorage(key));
  if (!Number.isFinite(saved) || saved <= 0) return `${limits.default}rem`;
  return `${Math.min(limits.max, Math.max(limits.min, saved))}rem`;
}

// Round to whole px before the rem conversion. The saved px is a little
// over the panel width, and a finer rounding keeps that extra, so the panel
// grows a little on each load.
function writeWidth(key: string, px: number) {
  const rootPx = parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  writeStorage(key, String(Math.round(px) / rootPx));
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

const DETAILS_DEFAULT_OPEN_QUERY = "(min-width: 90rem)";

/** Report whether a Conversation opens with its details panel. */
export function useDetailsDefaultOpen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(DETAILS_DEFAULT_OPEN_QUERY);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DETAILS_DEFAULT_OPEN_QUERY).matches,
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
