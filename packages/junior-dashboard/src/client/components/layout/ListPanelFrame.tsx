import type { ReactNode, RefObject } from "react";

import { PageLayout } from "./PageLayout";

/**
 * Scroll a list on its own, with row details in a slide-out panel over it.
 * The panel is an overlay `DetailsPanel`, so the list keeps its width.
 */
export function ListPanelFrame(props: {
  children: ReactNode;
  details: ReactNode;
  label: string;
  listRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="grid h-full min-h-0 min-w-0">
      <div
        aria-label={props.label}
        className="min-h-0 overflow-y-auto overscroll-contain outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
        ref={props.listRef}
        role="region"
        tabIndex={0}
      >
        <PageLayout>{props.children}</PageLayout>
      </div>
      {props.details}
    </div>
  );
}
