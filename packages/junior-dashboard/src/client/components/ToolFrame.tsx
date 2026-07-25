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
                  "hidden text-[#777] max-md:inline",
                  !staticFrame && "max-md:group-open:hidden",
                )}
              >
                ·
              </span>
              <span
                className={cn(
                  "hidden shrink-0 whitespace-nowrap text-[#888] max-md:inline",
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
          <TranscriptHeadingMeta className="min-w-0 break-words text-[0.8rem] text-[#888]">
            {metaText}
          </TranscriptHeadingMeta>
        ) : undefined
      }
      rightClassName="min-w-0 max-md:hidden"
    />
  );
  const mobileMeta =
    metaText && props.children ? (
      <div className="hidden min-w-0 break-words py-1 font-mono text-[0.78rem] leading-snug text-[#777] max-md:block">
        {metaText}
      </div>
    ) : null;

  // Force-expand tool details during search so highlighted matches are visible.
  if (staticFrame) {
    return (
      <div className={toolFrameClass()}>
        <div className={toolHeaderClass(false)}>{header}</div>
        {mobileMeta}
        {props.children}
      </div>
    );
  }

  return (
    <details className={cn("group", toolFrameClass())}>
      <summary className={toolHeaderClass(true)}>{header}</summary>
      {mobileMeta}
      {props.children}
    </details>
  );
}

/** Provide the shared transcript tool-frame shell for nonstandard part views. */
export function toolFrameClass(): string {
  return "min-w-0 max-w-full overflow-hidden";
}

function toolHeaderClass(interactive: boolean): string {
  return cn(
    "block py-1.5 font-mono text-[0.82rem] leading-tight text-[#b8b8b8]",
    interactive
      ? "cursor-pointer list-none transition-colors hover:text-white hover:[&_*]:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 focus-visible:text-white focus-visible:[&_*]:text-white [&::-webkit-details-marker]:hidden"
      : "cursor-default",
  );
}
