import type { ReactNode } from "react";

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
        "flex min-w-0 items-start justify-between gap-2 md:items-center md:gap-3",
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
        <div
          className={cn(
            "min-w-0 max-w-[60%] shrink text-right md:max-w-none md:shrink-0",
            props.rightClassName,
          )}
        >
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
    <span className={cn("font-sans leading-none", props.className)}>
      {props.children}
    </span>
  );
}
