import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { PaneCollapsedControls } from "./PaneNav";

/**
 * The bar that heads an Inbox list, the Automations list, and Code: the
 * hidden pane's controls, the way back to the page above, the title, then
 * the page's actions.
 */
export function HeaderBar(props: {
  actions?: ReactNode;
  back?: { label: string; to: string };
  /** Shows before the title, such as a Space's tile. */
  icon?: ReactNode;
  title: ReactNode;
}) {
  return (
    <div className="flex h-header min-w-0 shrink-0 items-center gap-2 border-b border-dashboard-border-subtle pr-4 pl-4 md:pl-6">
      <PaneCollapsedControls />
      {props.back ? (
        <Link
          aria-label={`Back to ${props.back.label}`}
          className="flex shrink-0 items-center gap-1.5 font-display text-sm font-medium text-dashboard-text-muted no-underline transition-colors hover:text-dashboard-text"
          to={props.back.to}
        >
          <ArrowLeft aria-hidden="true" size={15} strokeWidth={1.8} />
          {props.back.label}
        </Link>
      ) : null}
      {props.icon}
      <h1 className="m-0 min-w-0 truncate font-display text-lg font-medium tracking-[-0.01em] text-dashboard-text">
        {props.title}
      </h1>
      <span className="flex-1" />
      {props.actions}
    </div>
  );
}
