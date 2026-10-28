import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "../styles";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import { useTranscriptSearch } from "./transcriptSearch";
import { TranscriptSummary } from "./TranscriptSummary";

/** Frame expanded transcript activity content below its row title. */
export const transcriptActivityBodyClass =
  "ml-6 mt-1.5 min-w-0 overflow-hidden rounded-md border border-dashboard-border-subtle bg-dashboard-surface-panel";

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
  const interactive = props.expandable ?? Boolean(props.children);
  const staticFrame = searchActive || !interactive;
  const Icon = props.icon;
  const row = (
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
  const header = Icon ? (
    <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2">
      <Icon
        aria-hidden="true"
        className={cn("size-3.5 justify-self-center", props.iconClassName)}
        strokeWidth={2}
      />
      {row}
    </div>
  ) : (
    row
  );
  const mobileMeta =
    metaText && props.children ? (
      <div className="hidden min-w-0 break-words border-b border-dashboard-border-subtle px-2.5 py-1.5 font-sans text-xs tabular-nums leading-snug text-dashboard-text-muted max-md:block">
        {metaText}
      </div>
    ) : null;

  const body = props.children ? (
    <div className={transcriptActivityBodyClass}>
      {mobileMeta}
      {props.children}
    </div>
  ) : null;

  // Force-expand tool details during search so highlighted matches are visible.
  if (staticFrame) {
    return (
      <div className="min-w-0 max-w-full">
        <div className="block py-1.5 font-mono text-xs leading-tight text-dashboard-text-muted">
          {header}
        </div>
        {body}
      </div>
    );
  }

  return (
    <details
      className="group min-w-0 max-w-full"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <TranscriptSummary className="-mx-2 block font-mono text-xs leading-tight text-dashboard-text-muted">
        {header}
      </TranscriptSummary>
      {/* Closed details hide DOM, but still mount React children and run Shiki. */}
      {open ? body : null}
    </details>
  );
}
