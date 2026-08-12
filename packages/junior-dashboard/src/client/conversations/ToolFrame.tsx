import type { ReactNode } from "react";

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
  meta: string[];
  mobileSummaryMeta?: string;
  raw?: boolean;
  signature: ReactNode;
  status?: "running" | "completed" | "error" | "aborted";
}) {
  const { active: searchActive } = useTranscriptSearch();
  const metaText = props.meta.join(" · ");
  const interactive = props.expandable ?? Boolean(props.children);
  const staticFrame = searchActive || props.raw || !interactive;
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
      <div className="hidden min-w-0 break-words bg-black/15 px-2.5 py-1 font-mono text-2xs leading-snug text-dashboard-text-muted max-md:block">
        {metaText}
      </div>
    ) : null;

  // Force-expand tool details during search so highlighted matches are visible.
  if (staticFrame) {
    return (
      <div className={toolFrameClass(props.status)}>
        <div className={toolHeaderClass(false)}>{header}</div>
        {mobileMeta}
        {props.children}
      </div>
    );
  }

  return (
    <details className={cn("group", toolFrameClass(props.status))}>
      <summary className={toolHeaderClass(true)}>{header}</summary>
      {mobileMeta}
      {props.children}
    </details>
  );
}

/** Provide the shared transcript tool-frame shell for nonstandard part views. */
export function toolFrameClass(
  status?: "running" | "completed" | "error" | "aborted",
): string {
  const background =
    status === "running"
      ? "bg-cyan-300/[0.07]"
      : status === "error"
        ? "bg-rose-300/[0.09]"
        : "bg-white/[0.04]";
  return cn("min-w-0 max-w-full overflow-hidden rounded-md", background);
}

function toolHeaderClass(interactive: boolean): string {
  return cn(
    "block px-2.5 py-1.5 font-mono text-xs leading-tight text-dashboard-text-muted",
    interactive
      ? "cursor-pointer list-none transition-colors hover:bg-white/[0.03] hover:text-dashboard-text hover:[&_*]:text-dashboard-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 focus-visible:text-dashboard-text focus-visible:[&_*]:text-dashboard-text [&::-webkit-details-marker]:hidden"
      : "cursor-default",
  );
}
