import { cn } from "../styles";

/**
 * Each Inbox row is a card. An open one lifts out of the stream, as in
 * Google Inbox: more room above and below, and a deeper shadow.
 */
export function inboxCardClass(expanded: boolean): string {
  return cn(
    "min-w-0 list-none rounded-xl border transition-[margin,box-shadow,background-color] duration-200",
    expanded
      ? "my-4 border-dashboard-border-emphasis bg-dashboard-surface-raised shadow-[0_18px_44px_-14px_rgb(0_0_0/0.75),0_4px_14px_-6px_rgb(0_0_0/0.5)] light:shadow-[0_18px_44px_-14px_rgb(15_15_30/0.28),0_4px_14px_-6px_rgb(15_15_30/0.16)] md:-mx-2"
      : "border-dashboard-border bg-dashboard-surface-panel shadow-[0_1px_2px_rgb(0_0_0/0.4)] light:shadow-[0_1px_3px_rgb(15_15_30/0.08)]",
  );
}

/** The button that heads an Inbox row and expands it in place. */
export function inboxRowButtonClass(expanded: boolean): string {
  return cn(
    "grid w-full min-w-0 cursor-pointer grid-cols-[0.875rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-xl border-0 bg-transparent px-4 py-3 text-left font-sans text-inherit transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
    // Open, the header ends flat on the detail's rule, inside the card.
    expanded && "rounded-b-none",
  );
}

/**
 * The detail of an open Inbox row. It starts below the header's rule, with
 * the card's padding.
 */
export const INBOX_ROW_DETAIL_CLASS =
  "grid min-w-0 border-t border-dashboard-border px-4 pt-4 pb-4 md:px-6";
