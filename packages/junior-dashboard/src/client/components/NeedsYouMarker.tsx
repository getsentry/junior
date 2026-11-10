import { cn } from "../styles";

/**
 * Mark a list row that waits on the viewer, such as a Conversation with an
 * open question or an Automation that needs a fix. Conversations and
 * Automations share it, so "needs you" reads the same everywhere.
 */
export function NeedsYouMarker(props: { className?: string; title?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4.5 shrink-0 items-center rounded-full bg-dashboard-accent/15 px-1.5 font-sans text-2xs font-semibold uppercase tracking-wide text-dashboard-accent-text",
        props.className,
      )}
      title={props.title}
    >
      Needs you
    </span>
  );
}
