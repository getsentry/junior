import { cn, dashboardSurfaceRadiusClass } from "../styles";

/**
 * A card's shadow. It has no border: in a stack, the tray's tint and the
 * card's own surface tell them apart. Dark shows no shadow, so there a card
 * is a step lighter instead, and an open one keeps a hairline.
 */
const CARD_SURFACE_CLASS =
  "border-transparent bg-dashboard-bg shadow-[0_1px_2px_rgb(0_0_0/0.06),0_1px_4px_rgb(0_0_0/0.04)] dark:bg-dashboard-fill-soft";
const OPEN_CARD_SURFACE_CLASS =
  "my-4 border-transparent bg-dashboard-bg shadow-[0_2px_6px_rgb(0_0_0/0.08),0_8px_24px_rgb(0_0_0/0.08)] md:-mx-2 dark:border-dashboard-border dark:bg-dashboard-fill-hover";

/**
 * Each Inbox row is a card with a light shadow and no border. An open one
 * steps out of the stream, as in Google Inbox: more room above and below,
 * and a deeper shadow. A hover lights the whole closed card: its head,
 * Threads, and "Show N more". A Thread row adds its own hover on top.
 */
export function inboxCardClass(expanded: boolean): string {
  return cn(
    // The scale settles with a slight overshoot; height runs in `rowMotion`.
    dashboardSurfaceRadiusClass,
    "min-w-0 list-none border [transition:margin_200ms,border-color_200ms,background-color_200ms,box-shadow_200ms,transform_240ms_cubic-bezier(0.34,1.3,0.64,1)] motion-reduce:transition-none",
    expanded ? OPEN_CARD_SURFACE_CLASS : CARD_SURFACE_CLASS,
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

/**
 * A stack of rows: a tray with a light tint and no border, under its
 * cards. It grows under the pointer as a card does, so it has the card's
 * scale transition (`inboxCardClass`); without it, the stack jumps.
 */
export const INBOX_STACK_CLASS = cn(
  dashboardSurfaceRadiusClass,
  "grid min-w-0 list-none gap-1.5 bg-dashboard-fill-soft p-1.5 [transition:transform_240ms_cubic-bezier(0.34,1.3,0.64,1)] motion-reduce:transition-none",
);
