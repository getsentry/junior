import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
} from "../components/ui/trace";
import { cn } from "../styles";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import { useTranscriptSearch } from "./transcriptSearch";

/** Render the shared expandable/non-expandable frame for transcript tools. */
export function ToolFrame(props: {
  children?: ReactNode;
  expandable?: boolean;
  /** Icon in the activity icon column. Rail events pass their own icon. */
  icon?: LucideIcon;
  iconClassName?: string;
  meta: string[];
  mobileSummaryMeta?: string;
  signature: ReactNode;
}) {
  const { active: searchActive } = useTranscriptSearch();
  const [open, setOpen] = useState(false);
  const metaText = props.meta.join(" · ");
  const expandable = props.expandable ?? Boolean(props.children);
  // Force-expand tool details during search so highlighted matches are visible.
  const expanded = expandable && (searchActive || open);
  const Icon = props.icon;
  const row = (
    <TranscriptHeadingRow
      className="flex-1"
      left={
        <>
          {props.signature}
          {props.mobileSummaryMeta && !expanded ? (
            <>
              <span className="hidden text-dashboard-text-muted max-md:inline">
                ·
              </span>
              <span className="hidden shrink-0 whitespace-nowrap text-dashboard-text-muted max-md:inline">
                {props.mobileSummaryMeta}
              </span>
            </>
          ) : null}
        </>
      }
      leftClassName={cn(
        "gap-x-1 gap-y-0.5",
        expandable && !expanded ? "flex-nowrap" : "flex-wrap",
      )}
      right={
        metaText ? (
          <TranscriptHeadingMeta className="min-w-0 break-words text-xs text-dashboard-text-muted">
            {metaText}
          </TranscriptHeadingMeta>
        ) : undefined
      }
      rightClassName="ml-3 min-w-0 max-md:hidden"
    />
  );
  const header = Icon ? (
    <span className="grid min-w-0 flex-1 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2">
      <Icon
        aria-hidden="true"
        className={cn("size-3.5 justify-self-center", props.iconClassName)}
        strokeWidth={2}
      />
      {row}
    </span>
  ) : (
    row
  );

  if (!expandable) {
    return (
      <div className="flex min-w-0 max-w-full py-1.5 font-mono text-xs leading-tight text-dashboard-text-muted">
        {header}
      </div>
    );
  }

  return (
    <TraceCollapsible
      className="max-w-full"
      // Search holds rows open, so the row button is off until search ends.
      disabled={searchActive}
      open={expanded}
      onOpenChange={setOpen}
    >
      <TraceCollapsibleTrigger className="-mx-2 w-auto font-mono text-xs leading-tight">
        {header}
      </TraceCollapsibleTrigger>
      {/* The closed panel unmounts, so closed rows do not run Shiki. */}
      <TraceCollapsibleContent>
        {metaText ? (
          <div className="hidden min-w-0 break-words border-b border-dashboard-border-subtle px-2.5 py-1.5 font-sans text-xs tabular-nums leading-snug text-dashboard-text-muted max-md:block">
            {metaText}
          </div>
        ) : null}
        {props.children}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
