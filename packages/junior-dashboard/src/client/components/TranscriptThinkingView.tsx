import { useEffect, useRef, useState } from "react";

import { formatMessageTimestamp, stringifyPartValue } from "../format";
import { cn } from "../styles";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
  TranscriptThoughtLabel,
} from "./TranscriptHeadingRow";
import { previewToolValue } from "./transcriptPreview";

const PREVIEW_OVERFLOW_EPSILON = 1;

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Render a thinking transcript event with layout-aware expansion. */
export function TranscriptThinkingView(props: {
  timestamp?: number;
  value: unknown;
}) {
  const [open, setOpen] = useState(false);
  const [previewOverflows, setPreviewOverflows] = useState(false);
  const previewMeasureRef = useRef<HTMLSpanElement>(null);
  const rendered = stringifyPartValue(props.value);
  const expandedText = rendered || "{}";
  const preview = previewToolValue(props.value);
  const contentChangesOnExpand =
    preview !== expandedText || expandedText.includes("\n");
  const shouldMeasurePreview = !contentChangesOnExpand;
  const meta = [
    typeof props.timestamp === "number"
      ? formatMessageTimestamp(props.timestamp)
      : undefined,
  ].filter(isString);
  const metaText = meta.join(" · ");
  const canExpand = contentChangesOnExpand || previewOverflows;

  useEffect(() => {
    if (!shouldMeasurePreview) {
      setPreviewOverflows(false);
      return;
    }

    const node = previewMeasureRef.current;
    if (!node) return;

    const measure = () => {
      const next =
        node.scrollWidth - node.clientWidth > PREVIEW_OVERFLOW_EPSILON;
      setPreviewOverflows((current) => (current === next ? current : next));
    };
    measure();

    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(node);
    if (node.parentElement) observer?.observe(node.parentElement);
    window.addEventListener("resize", measure);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [preview, shouldMeasurePreview]);

  useEffect(() => {
    if (!canExpand && open) setOpen(false);
  }, [canExpand, open]);

  const rowContent = (expanded: boolean) => (
    <>
      <TranscriptThoughtLabel />
      <TranscriptHeadingRow
        className={expanded ? "items-start" : undefined}
        left={
          <span className="relative min-w-0 flex-1 italic">
            {shouldMeasurePreview ? (
              <span
                aria-hidden="true"
                className="pointer-events-none invisible absolute inset-x-0 top-0 block truncate"
                ref={previewMeasureRef}
              >
                {preview}
              </span>
            ) : null}
            <span
              className={cn(
                "block min-w-0",
                expanded
                  ? "whitespace-pre-wrap break-words text-[#9a9a9a]"
                  : "truncate",
              )}
            >
              {expanded ? expandedText : preview}
            </span>
          </span>
        }
        leftClassName={expanded ? "items-start" : undefined}
        right={
          metaText ? (
            <TranscriptHeadingMeta className="min-w-0 break-words text-[0.78rem] not-italic text-[#777] max-md:hidden">
              {metaText}
            </TranscriptHeadingMeta>
          ) : undefined
        }
        rightClassName="min-w-0 max-md:hidden"
      />
    </>
  );

  if (!canExpand) {
    return (
      <div className="py-1.5 text-[0.84rem] leading-relaxed text-[#888]">
        <div className="grid list-none grid-cols-[1rem_minmax(0,1fr)] items-start gap-2">
          {rowContent(false)}
        </div>
      </div>
    );
  }

  return (
    <details
      className="py-1.5 text-[0.84rem] leading-relaxed text-[#888]"
      onToggle={(event) => {
        if (event.currentTarget !== event.target) return;
        setOpen(event.currentTarget.open);
      }}
      open={open}
    >
      <summary className="grid cursor-pointer list-none grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 transition-colors hover:text-[#b8b8b8] [&::-webkit-details-marker]:hidden">
        {rowContent(open)}
      </summary>
      {metaText ? (
        <div className="hidden min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-2 max-md:grid">
          <span aria-hidden="true" />
          <div className="min-w-0 break-words py-1 font-mono text-[0.78rem] not-italic leading-snug text-[#777]">
            {metaText}
          </div>
        </div>
      ) : null}
    </details>
  );
}
