import type { ReactNode } from "react";

import {
  TimeRangeSelector,
  type TimeRangeDays,
} from "../controls/TimeRangeSelector";
import { useDocumentTitle } from "../../documentTitle";
import { cn } from "../../styles";

/**
 * Render a spacious analytics page heading with optional controls.
 *
 * Also names the browser tab after the page. Pass `documentTitle` when the tab
 * needs more context than the visible heading. Pass `navigation` to put page
 * links under the heading, with their underline on the header border.
 */
export function PageHeader(props: {
  actions?: ReactNode;
  description?: ReactNode;
  documentTitle?: string;
  navigation?: ReactNode;
  onRangeChange?(value: TimeRangeDays): void;
  range?: TimeRangeDays;
  rangeOptions?: TimeRangeDays[];
  title: ReactNode;
}) {
  useDocumentTitle(
    props.documentTitle ??
      (typeof props.title === "string" ? props.title : undefined),
  );
  const rangeActions =
    props.range !== undefined && props.onRangeChange ? (
      <TimeRangeSelector
        onChange={props.onRangeChange}
        {...(props.rangeOptions ? { options: props.rangeOptions } : {})}
        value={props.range}
      />
    ) : undefined;
  const actions = props.actions ?? rangeActions;

  return (
    <header
      className={cn(
        "min-w-0 border-b border-dashboard-border-subtle",
        !props.navigation && "pb-4 sm:pb-6",
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-6 max-md:flex-col max-md:items-stretch">
        <div className="min-w-0">
          <h2 className="m-0 font-display text-3xl font-light leading-none tracking-[-0.03em] text-dashboard-text sm:text-4xl">
            {props.title}
          </h2>
          {props.description ? (
            <div className="mt-2 max-w-2xl font-sans text-xs leading-relaxed text-dashboard-text-muted sm:text-sm">
              {props.description}
            </div>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {props.navigation ? (
        <div className="mt-4 sm:mt-6">{props.navigation}</div>
      ) : null}
    </header>
  );
}
