import type { ReactNode } from "react";

import { MessageActions } from "../components/ui/message";
import { cn } from "../styles";

/** Align transcript labels and metadata as one centered heading row. Spans keep it valid inside a row button. */
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
    <span
      className={cn(
        "flex min-w-0 items-start justify-between gap-2 md:items-center md:gap-3",
        props.className,
      )}
    >
      <span
        className={cn(
          "flex min-w-0 items-center gap-2 overflow-hidden",
          props.leftClassName,
        )}
      >
        {props.left}
      </span>
      {hasRight ? (
        <span
          className={cn(
            "min-w-0 max-w-[60%] shrink text-right md:max-w-none md:shrink-0",
            props.rightClassName,
          )}
        >
          {props.right}
        </span>
      ) : null}
    </span>
  );
}

/** Keep message authors, timestamps, and actions together at the text edge. */
export function TranscriptMessageHeading(props: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-6 min-w-0 flex-wrap items-baseline gap-x-2 text-sm leading-6">
      {props.children}
      {props.action ? (
        <MessageActions className="h-6 shrink-0 self-center">
          {props.action}
        </MessageActions>
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
    <span className={cn("font-sans leading-none", props.className)}>
      {props.children}
    </span>
  );
}
