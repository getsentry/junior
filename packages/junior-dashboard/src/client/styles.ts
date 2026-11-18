/** Join component-owned Tailwind classes without pulling in a styling dependency. */
export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

export const dashboardContainerClass = "mx-auto w-full min-w-0 max-w-screen-xl";

/** Underline a neutral inline link, such as a channel or record name in prose. */
export const dashboardInlineLinkClass =
  "text-dashboard-text underline decoration-dashboard-border-heavy underline-offset-2 transition-colors hover:decoration-dashboard-text-muted";

export const dashboardInteractiveTextClass =
  "text-dashboard-text-muted hover:text-dashboard-text";

/** Raised input surface so the chat box reads against the near-black shell. */
export const dashboardComposerSurfaceClass =
  "rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-raised shadow-[0_8px_32px_rgba(0,0,0,0.35)] transition-colors light:shadow-[0_4px_20px_rgba(0,0,0,0.12)]";

/** Turn a disclosure chevron when its `group` trigger sets `aria-expanded`. */
export const dashboardDisclosureChevronClass =
  "size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none";

// One core style for both UIs. The classic and new UIs draw the surfaces
// below from these classes, so their radii, frames, and counts cannot drift.
// `pnpm lint` (oxlint `radius/no-large-radius`) blocks the larger
// radii in `inbox/` and `review-desk/`.

/** Round a card, row, or panel. Buttons, tabs, inputs, and icon tiles use `rounded-md`. */
export const dashboardSurfaceRadiusClass = "rounded-lg";

/** Frame one message-like record in a transcript, such as an object preview or a review item. */
export const dashboardMessageCardClass =
  "rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-panel";

/** Frame the icon at the start of a record. Size it at the call site. */
export const dashboardIconTileClass =
  "grid shrink-0 place-items-center rounded-md border border-dashboard-border bg-dashboard-fill-soft text-dashboard-text-muted";

/** Show a count beside a label as quiet plain text, not a badge. */
export const dashboardCountClass = "tabular-nums text-dashboard-text-faint";
