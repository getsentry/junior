/** Style one icon button in a sidebar row's hover actions. */
export const ROW_ACTION_BUTTON_CLASS =
  "grid size-7 cursor-pointer place-items-center rounded-md text-dashboard-text-muted transition hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus disabled:cursor-not-allowed";

/**
 * Show a sidebar row's actions on hover or focus. Mobile has no hover, so
 * they always show there.
 */
export const ROW_ACTIONS_REVEAL_CLASS =
  "z-10 flex gap-0.5 transition sm:pointer-events-none sm:opacity-0 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100";

/**
 * Fade the row content out under the row actions while they show, so the
 * title does not end in a hard cut. Each row sets --row-actions-width.
 */
export const ROW_ACTIONS_FADE_CLASS =
  "sm:group-hover:[mask-image:linear-gradient(to_left,transparent_var(--row-actions-width),black_calc(var(--row-actions-width)+2rem))] sm:group-focus-within:[mask-image:linear-gradient(to_left,transparent_var(--row-actions-width),black_calc(var(--row-actions-width)+2rem))]";
