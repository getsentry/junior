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
  "rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-raised shadow-[0_8px_32px_rgba(0,0,0,0.35)] transition-colors";

/** Turn a disclosure chevron when its `group` trigger sets `aria-expanded`. */
export const dashboardDisclosureChevronClass =
  "size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none";
