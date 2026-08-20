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
  "rounded-lg border border-white/12 bg-[#1a1a1c]";
