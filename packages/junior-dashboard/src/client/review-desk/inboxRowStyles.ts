import { cn, dashboardSurfaceRadiusClass } from "../styles";

/**
 * Each Inbox row is a card with a hairline border and no shadow. An open one
 * steps out of the stream, as in Google Inbox: more room above and below, a
 * panel surface, and a stronger border. A hover lights the whole closed card:
 * its head, Threads, and "Show N more". A Thread row adds its own hover on
 * top.
 */
export function inboxCardClass(expanded: boolean): string {
  return cn(
    // The scale settles with a slight overshoot; height runs in `rowMotion`.
    dashboardSurfaceRadiusClass,
    "min-w-0 list-none border [transition:margin_200ms,border-color_200ms,background-color_200ms,transform_240ms_cubic-bezier(0.34,1.3,0.64,1)] motion-reduce:transition-none",
    expanded
      ? "my-4 border-dashboard-border-strong bg-dashboard-surface-panel md:-mx-2"
      : "border-dashboard-border",
    // The hover layer sits under the content and over the card's surface.
    !expanded &&
      "relative isolate before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:transition-colors hover:before:bg-dashboard-fill-hover",
  );
}

/**
 * The head of an Inbox row, as a grid: the dot or status icon, the title
 * line at full width, then the meta; the summary goes under the title.
 * Conversation and Automation rows share it, so their columns line up.
 * The title starts 2rem in, the left edge of the sections under it.
 */
export function inboxHeadGridClass(): string {
  return cn(
    "grid min-w-0 grid-cols-[0.5rem_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1.5 px-4 pt-3",
    dashboardSurfaceRadiusClass,
  );
}

/** The meta at the end of an Inbox row head, such as its age. */
export const INBOX_ROW_META_CLASS =
  "col-start-3 row-start-1 flex items-center gap-2 pt-0.5 text-xs tabular-nums text-dashboard-text-faint";

/** The button that heads an Inbox row and expands it in place. */
export function inboxRowButtonClass(expanded: boolean): string {
  return cn(
    dashboardSurfaceRadiusClass,
    "grid w-full min-w-0 cursor-pointer grid-cols-[0.875rem_minmax(0,1fr)_auto] items-start gap-x-3 border-0 bg-transparent px-4 py-3 text-left font-sans text-inherit transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
    // Open, the header ends flat on the detail's rule, inside the card. A
    // closed card lights as a whole instead.
    expanded && "rounded-b-none hover:bg-dashboard-fill-hover",
  );
}

/**
 * The detail of an open Inbox row. It starts below the header's rule, with
 * the card's padding.
 */
export const INBOX_ROW_DETAIL_CLASS =
  "grid min-w-0 border-t border-dashboard-border px-4 pt-4 pb-4 md:px-6";
