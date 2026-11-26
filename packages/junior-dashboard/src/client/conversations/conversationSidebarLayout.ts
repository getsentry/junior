import { useState, useSyncExternalStore } from "react";
import type { PanelSize, RemSize } from "../components/ui/resizable";
import { DESKTOP_LAYOUT_QUERY } from "../layoutMedia";

import { hasPanelSpace, useDetailsPanel } from "../components/DetailsPanel";

const OPEN_KEY = "junior:conversation:sidebar-open";
const DETAILS_OPEN_KEY = "junior:conversation:details-open";
// Widths are in rem, so panels keep room for their text when the reader
// changes the browser font size. The keys name the unit, so a width saved in
// px before is not read as rem.
const DETAILS_WIDTH_KEY = "junior:conversation:details-width-rem";

/**
 * Rem limits for the desktop pane. It holds only short row names, so it
 * starts slim, but wide enough for "Search" and its shortcut chip in the top
 * bar.
 */
export const PANE_WIDTH = { default: 18, max: 30, min: 13 } as const;
const PANE_WIDTH_KEY = "junior:pane-width-rem";

/** Rem limits for the details panel beside the transcript. */
export const DETAILS_WIDTH = { max: 60, min: 20 } as const;

/**
 * Until the reader resizes it, the details panel takes a share of its
 * column, so it grows on wide screens. The rem limits keep it as wide as
 * before on a laptop, and stop it from taking over a very wide column.
 */
const DETAILS_DEFAULT = { max: 50, min: 25, share: 0.35 } as const;

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

/** Read the desktop pane width saved in this browser, in rem. */
export function readPaneWidth(): number {
  return parseFloat(readWidth(PANE_WIDTH_KEY, PANE_WIDTH));
}

/** Save the desktop pane width, given in px. */
export function savePaneWidth(px: number) {
  writeWidth(PANE_WIDTH_KEY, px);
}

/**
 * Read the details panel width saved in this browser, or its default share
 * of a column `columnPx` wide. With no column width yet, the share alone.
 */
export function readDetailsWidth(columnPx: number): PanelSize {
  const saved = readSavedWidth(DETAILS_WIDTH_KEY);
  if (saved !== undefined) return clampRem(saved, DETAILS_WIDTH);
  if (columnPx <= 0) return `${DETAILS_DEFAULT.share * 100}%`;
  return defaultDetailsWidth(columnPx / rootFontPx());
}

/** Give the details panel width, in rem, for a column `columnRem` wide. */
export function defaultDetailsWidth(columnRem: number): RemSize {
  return clampRem(columnRem * DETAILS_DEFAULT.share, DETAILS_DEFAULT);
}

/** Save the details panel width in px without a React render per drag step. */
export function saveDetailsWidth(px: number) {
  writeWidth(DETAILS_WIDTH_KEY, px);
}

function readWidth(key: string, limits: WidthLimits): RemSize {
  return clampRem(readSavedWidth(key) ?? limits.default, limits);
}

function readSavedWidth(key: string): number | undefined {
  const saved = Number(readStorage(key));
  return Number.isFinite(saved) && saved > 0 ? saved : undefined;
}

function clampRem(rem: number, limits: { max: number; min: number }): RemSize {
  return `${Math.min(limits.max, Math.max(limits.min, rem))}rem`;
}

function rootFontPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize);
}

// Round to whole px before the rem conversion. The saved px is a little
// over the panel width, and a finer rounding keeps that extra, so the panel
// grows a little on each load.
function writeWidth(key: string, px: number) {
  writeStorage(key, String(Math.round(px) / rootFontPx()));
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

/**
 * Report whether a Conversation opens with its details panel. The pending
 * view of a new Conversation and the page that replaces it both use this,
 * so details do not open and then close when the page loads.
 */
export function useDetailsStartOpen(): boolean {
  const defaultOpen = useDetailsDefaultOpen();
  const panelFits = useDetailsPanel();
  // Read once, so a choice made on this page does not change its default.
  const [saved] = useState(readDetailsOpen);
  // A saved open choice applies only beside the transcript, so a narrow
  // screen does not load into a bottom sheet.
  return saved === undefined ? defaultOpen : saved && panelFits;
}

function useDetailsDefaultOpen(): boolean {
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
