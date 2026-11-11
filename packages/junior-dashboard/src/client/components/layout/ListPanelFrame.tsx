import type { ReactNode, RefObject } from "react";

import { cn } from "../../styles";
import { PageLayout } from "./PageLayout";

/**
 * Scroll a list on its own, beside one panel, such as row details. Below
 * `xl` the panel is a modal sheet, so the list keeps the full width.
 */
export function ListPanelFrame(props: {
  children: ReactNode;
  details: ReactNode;
  label: string;
  listRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      className={cn(
        "grid h-full min-h-0 min-w-0",
        props.details ? "xl:grid-cols-[minmax(0,1fr)_25rem]" : undefined,
      )}
    >
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
