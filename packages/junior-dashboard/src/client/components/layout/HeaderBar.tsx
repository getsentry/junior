import type { ReactNode } from "react";

import { PaneCollapsedControls } from "./PaneNav";

/**
 * The bar that heads an Inbox list and the Automations list: the hidden
 * pane's controls, the title, then the page's actions.
 */
export function HeaderBar(props: { actions?: ReactNode; title: ReactNode }) {
  return (
    <div className="flex h-header min-w-0 shrink-0 items-center gap-2 border-b border-dashboard-border-subtle pr-4 pl-4 md:pl-6">
      <PaneCollapsedControls />
      <h1 className="m-0 min-w-0 truncate font-display text-lg font-medium tracking-[-0.01em] text-dashboard-text">
        {props.title}
      </h1>
      <span className="flex-1" />
      {props.actions}
    </div>
  );
}
