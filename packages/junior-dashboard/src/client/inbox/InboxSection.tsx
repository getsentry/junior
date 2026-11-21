import { X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../components/ui/button";
import { ConversationSectionHeading } from "../conversations/ConversationSectionHeading";
import { useConversationDensity } from "../conversations/conversationDensity";
import { cn } from "../styles";

/**
 * One labelled group in the inbox stream, under a heading.
 * It hides when empty, and its heading collapses it.
 */
export function InboxSection(props: {
  /** Shows at the end of the heading, such as the section's sweep. */
  action?: ReactNode;
  /** Shows after the label while the section is open, such as a count. */
  badge?: ReactNode;
  children: ReactNode;
  collapsed: boolean;
  /** Shows after the rows while the section is open, such as its paging. */
  footer?: ReactNode;
  count: number;
  label: string;
  onToggle(): void;
}) {
  const [density] = useConversationDensity();
  if (props.count === 0) return null;
  return (
    <section aria-label={props.label} className="grid gap-2 pt-5 first:pt-1">
      {/* A heading a step larger than the card titles splits the stream
          of cards, with no rule. */}
      <div className="flex min-h-9 items-end gap-2 pr-1 pb-1">
        <ConversationSectionHeading
          className="px-1"
          collapsed={props.collapsed}
          count={props.count}
          label={props.label}
          onToggle={props.onToggle}
          size="heading"
        />
        {props.collapsed ? null : props.badge}
        <span className="flex-1" />
        {props.action}
      </div>
      {props.collapsed ? null : (
        <>
          {/* Comfortable cards get more room between them. */}
          <ul
            className={cn(
              "m-0 grid p-0",
              density === "comfortable" ? "gap-3" : "gap-2",
            )}
            data-dock-list=""
          >
            {props.children}
          </ul>
          {props.footer}
        </>
      )}
    </section>
  );
}

/** What an Inbox list, or a list in its style, says when it has no rows. */
export function InboxEmptyState(props: { label: string }) {
  return (
    <p className="m-0 py-16 text-center font-display text-base font-medium text-dashboard-text">
      {props.label}
    </p>
  );
}

/** Dismiss the FYIs in some rows. Asks stay. */
export function SweepControl(props: {
  clear: number;
  onSweep(): void;
  scope: string;
}) {
  if (props.clear === 0) return null;
  // Bulk actions read `<verb> <number>`; the section names what it dismisses.
  const label = `Dismiss ${props.clear}`;
  return (
    <Button
      aria-label={`${label} in ${props.scope}`}
      className="h-6 gap-1 px-1.5 text-xs"
      onClick={props.onSweep}
      variant="ghost"
    >
      <X aria-hidden="true" className="size-3.5" />
      {label}
    </Button>
  );
}
