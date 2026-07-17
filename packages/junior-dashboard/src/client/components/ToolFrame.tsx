import { useState, type ReactNode } from "react";

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
  const [open, setOpen] = useState(false);
  const { active: searchActive } = useTranscriptSearch();
  const metaText = props.meta.join(" · ");
  const interactive = props.expandable ?? Boolean(props.children);
  const mobileSummaryMeta =
    props.mobileSummaryMeta && (!interactive || !open)
      ? props.mobileSummaryMeta
      : undefined;
  const header = (
    <TranscriptHeadingRow
      left={
        <>
          {props.signature}
          {mobileSummaryMeta ? (
            <>
              <span className="hidden text-[#777] max-md:inline">·</span>
              <span className="hidden min-w-0 break-words text-[#888] max-md:inline">
                {mobileSummaryMeta}
              </span>
            </>
          ) : null}
        </>
      }
      leftClassName={cn(
        "gap-x-1 gap-y-0.5",
        interactive && !open ? "flex-nowrap" : "flex-wrap",
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
  if (searchActive || props.raw || !interactive) {
    return (
      <div className={toolFrameClass()}>
        <div className={toolHeaderClass(false)}>{header}</div>
        {mobileMeta}
        {props.children}
      </div>
    );
  }

  return (
    <details
      className={toolFrameClass()}
      onToggle={(event) => {
        if (event.currentTarget !== event.target) return;
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className={toolHeaderClass(true)}>{header}</summary>
      {mobileMeta}
      {props.children}
    </details>
  );
}

/** Provide the shared transcript tool-frame shell for nonstandard part views. */
export function toolFrameClass(): string {
  return "min-w-0 max-w-full overflow-hidden rounded-lg border border-white/[0.055] bg-black/15 px-3";
}

function toolHeaderClass(interactive: boolean): string {
  return cn(
    "block py-1.5 font-mono text-[0.82rem] leading-tight text-[#b8b8b8]",
    interactive
      ? "cursor-pointer list-none transition-colors hover:text-white hover:[&_*]:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 focus-visible:text-white focus-visible:[&_*]:text-white [&::-webkit-details-marker]:hidden"
      : "cursor-default",
  );
}
