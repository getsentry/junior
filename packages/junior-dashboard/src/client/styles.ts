/** Join component-owned Tailwind classes without pulling in a styling dependency. */
export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

export const dashboardContainerClass = "mx-auto w-full min-w-0 max-w-screen-xl";

export const dashboardInteractiveTextClass =
  "text-dashboard-text-muted hover:text-dashboard-text";

/**
 * Mobile composer bottom pad. Owned by `useMobileViewportHeight` via
 * `--dashboard-composer-dock-padding`. Do not add env(safe-area-inset-*) here.
 */
export const dashboardComposerDockClass =
  "pb-[var(--dashboard-composer-dock-padding,0.375rem)]";

/** Raised input surface so the chat box reads against the near-black shell. */
export const dashboardComposerSurfaceClass =
  "rounded-lg border border-white/12 bg-[#1a1a1c]";
