import { cn } from "../styles";

// An open card's surface and lift.
const LIFTED_CARD_CLASS =
  "border-dashboard-border-emphasis bg-dashboard-surface-raised shadow-[0_18px_44px_-14px_rgb(0_0_0/0.75),0_4px_14px_-6px_rgb(0_0_0/0.5)] light:shadow-[0_18px_44px_-14px_rgb(15_15_30/0.28),0_4px_14px_-6px_rgb(15_15_30/0.16)]";

/**
 * Each Inbox row is a card. An open one lifts out of the stream, as in
 * Google Inbox: more room above and below, and a deeper shadow. A hover
 * lights the whole closed card: its head, Threads, and "Show N more". A
 * Thread row adds its own hover on top.
 */
export function inboxCardClass(expanded: boolean): string {
  return cn(
    "min-w-0 list-none rounded-xl border transition-[margin,box-shadow,background-color,transform] duration-200 [--inbox-lead:16rem]",
    expanded
      ? cn("my-4 md:-mx-2", LIFTED_CARD_CLASS)
      : "border-dashboard-border bg-dashboard-surface-panel shadow-[0_1px_2px_rgb(0_0_0/0.4)] light:shadow-[0_1px_3px_rgb(15_15_30/0.08)]",
    // The hover layer sits under the content and over the card's surface.
    !expanded &&
      "relative isolate before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:transition-colors hover:before:bg-dashboard-fill-hover",
  );
}

/**
 * The head of an Inbox row, as a grid: the dot or status icon, the title
 * column, then the meta. With `columns`, wider screens put the summary
 * between the title column and the meta. Conversation and Automation rows
 * share it, so their columns line up.
 */
export function inboxHeadGridClass(columns: boolean): string {
  return cn(
    "grid min-w-0 grid-cols-[0.5rem_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-xl px-3 pt-2.5",
    columns &&
      "gap-y-1 sm:grid-cols-[0.5rem_var(--inbox-lead)_minmax(0,1fr)_auto]",
  );
}

/**
 * The card that shows more of a row on hover. It floats over the rows below
 * with an open card's lift, so no row moves.
 */
export const INBOX_HOVER_CARD_CLASS = cn(
  "pointer-events-none absolute -top-px -right-px -left-px z-5 rounded-xl border",
  LIFTED_CARD_CLASS,
);

/** The meta at the end of an Inbox row head, such as its age. */
export const INBOX_ROW_META_CLASS =
  "col-start-3 row-start-1 flex items-center gap-1 pt-0.5 text-xs tabular-nums text-dashboard-text-faint";

/** The button that heads an Inbox row and expands it in place. */
export function inboxRowButtonClass(expanded: boolean): string {
  return cn(
    "grid w-full min-w-0 cursor-pointer grid-cols-[0.875rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-xl border-0 bg-transparent px-4 py-3 text-left font-sans text-inherit transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
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
