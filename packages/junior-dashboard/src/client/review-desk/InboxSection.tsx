import type { ReactNode } from "react";

import { ConversationSectionHeading } from "../conversations/ConversationSectionHeading";

/**
 * One labelled group in the inbox stream, with a bold heading and a rule.
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
  if (props.count === 0) return null;
  return (
    <section aria-label={props.label} className="grid gap-2 pt-5 first:pt-1">
      {/* A bold heading and a rule split the stream of cards. */}
      <div className="flex min-h-9 items-end gap-2 border-b border-dashboard-border pr-1 pb-1.5">
        <ConversationSectionHeading
          className="px-1 font-semibold text-dashboard-text [&_*]:text-dashboard-text"
          collapsed={props.collapsed}
          count={props.count}
          label={props.label}
          onToggle={props.onToggle}
        />
        {props.collapsed ? null : props.badge}
        <span className="flex-1" />
        {props.action}
      </div>
      {props.collapsed ? null : (
        <>
          <ul className="m-0 grid gap-2 p-0" data-dock-list="">
            {props.children}
          </ul>
          {props.footer}
        </>
      )}
    </section>
  );
}
