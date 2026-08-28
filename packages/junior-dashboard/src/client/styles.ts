/** Join component-owned Tailwind classes without pulling in a styling dependency. */
export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

export const dashboardContainerClass = "mx-auto w-full min-w-0 max-w-screen-xl";

export const dashboardInteractiveTextClass =
  "text-dashboard-text-muted hover:text-dashboard-text";

/** Raised input surface so the chat box reads against the near-black shell. */
export const dashboardComposerSurfaceClass =
  "rounded-2xl bg-dashboard-fill-soft shadow-[inset_0_0_0_1px_var(--color-dashboard-border-subtle)]";

/** Shared shell canvas + grid background class from `tailwind.css`. */
export const dashboardShellBgClass = "dashboard-shell-bg";
