import type { ReactNode } from "react";
import { Brain } from "lucide-react";

import { cn } from "../styles";

/** Align transcript labels and metadata as one centered heading row. */
export function TranscriptHeadingRow(props: {
  className?: string;
  left: ReactNode;
  leftClassName?: string;
  right?: ReactNode;
  rightClassName?: string;
}) {
  const hasRight =
    props.right !== undefined && props.right !== null && props.right !== false;

  return (
    <div
      className={cn(
        "flex min-w-0 items-center justify-between gap-3",
        props.className,
      )}
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 overflow-hidden",
          props.leftClassName,
        )}
      >
        {props.left}
      </div>
      {hasRight ? (
        <div className={cn("shrink-0 text-right", props.rightClassName)}>
          {props.right}
        </div>
      ) : null}
    </div>
  );
}

/** Render compact transcript heading metadata without changing row alignment. */
export function TranscriptHeadingMeta(props: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("font-mono leading-none", props.className)}>
      {props.children}
    </span>
  );
}

/** Render the thinking-row label with stable optical vertical centering. */
export function TranscriptThoughtLabel() {
  return (
    <span
      aria-label="Thinking"
      className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center text-[#777]"
      title="Thinking"
    >
      <Brain aria-hidden="true" size={14} strokeWidth={1.8} />
    </span>
  );
}
