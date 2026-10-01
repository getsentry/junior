import { useState, type ReactNode } from "react";

import { cn } from "../styles";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import { useTranscriptSearch } from "./transcriptSearch";
import { TranscriptSummary } from "./TranscriptSummary";

/** Render the shared expandable/non-expandable frame for transcript tools. */
export function ToolFrame(props: {
  children?: ReactNode;
  expandable?: boolean;
  meta: string[];
  mobileSummaryMeta?: string;
  signature: ReactNode;
}) {
  const { active: searchActive } = useTranscriptSearch();
  const [open, setOpen] = useState(false);
  const metaText = props.meta.join(" · ");
  const interactive = props.expandable ?? Boolean(props.children);
  const staticFrame = searchActive || !interactive;
  const header = (
    <TranscriptHeadingRow
      left={
        <>
          {props.signature}
          {props.mobileSummaryMeta ? (
            <>
              <span
                className={cn(
                  "hidden text-dashboard-text-muted max-md:inline",
                  !staticFrame && "max-md:group-open:hidden",
                )}
              >
                ·
              </span>
              <span
                className={cn(
                  "hidden shrink-0 whitespace-nowrap text-dashboard-text-muted max-md:inline",
                  !staticFrame && "max-md:group-open:hidden",
                )}
              >
                {props.mobileSummaryMeta}
              </span>
            </>
          ) : null}
        </>
      }
      leftClassName={cn(
        "gap-x-1 gap-y-0.5",
        staticFrame ? "flex-wrap" : "flex-nowrap group-open:flex-wrap",
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
  const mobileMeta =
    metaText && props.children ? (
      <div className="hidden min-w-0 break-words bg-black/15 px-2 py-1 font-mono text-xs leading-snug text-dashboard-text-muted max-md:block">
        {metaText}
      </div>
    ) : null;

  // Force-expand tool details during search so highlighted matches are visible.
  if (staticFrame) {
    return (
      <div className="min-w-0 max-w-full overflow-hidden">
        <div className="block px-2 py-1.5 font-mono text-xs leading-tight text-dashboard-text-muted">
          {header}
        </div>
        {mobileMeta}
        {props.children}
      </div>
    );
  }

  return (
    <details
      className="group min-w-0 max-w-full overflow-hidden"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <TranscriptSummary className="block font-mono text-xs leading-tight text-dashboard-text-muted">
        {header}
      </TranscriptSummary>
      {/* Closed details hide DOM, but still mount React children and run Shiki. */}
      {open ? (
        <>
          {mobileMeta}
          {props.children}
        </>
      ) : null}
    </details>
  );
}
