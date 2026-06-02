import type { ReactNode } from "react";

import { cn } from "../styles";

/** Render the shared expandable/non-expandable frame for transcript tools. */
export function ToolFrame(props: {
  children?: ReactNode;
  meta: string[];
  raw?: boolean;
  signature: ReactNode;
}) {
  const header = (
    <>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-0.5 overflow-hidden">
        {props.signature}
      </span>
      <span className="min-w-0 break-words text-right text-[0.8rem] text-[#888] max-md:hidden">
        {props.meta.join(" · ")}
      </span>
    </>
  );

  if (props.raw) {
    return (
      <div className={toolFrameClass()}>
        <div className={toolHeaderClass(false)}>{header}</div>
        {props.children}
      </div>
    );
  }

  return (
    <details className={toolFrameClass()}>
      <summary className={toolHeaderClass(true)}>{header}</summary>
      {props.children}
    </details>
  );
}

/** Provide the shared transcript tool-frame shell for nonstandard part views. */
export function toolFrameClass(): string {
  return "min-w-0";
}

function toolHeaderClass(interactive: boolean): string {
  return cn(
    "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-1.5 font-mono text-[0.82rem] leading-tight text-[#b8b8b8] max-md:grid-cols-1 max-md:gap-1",
    interactive
      ? "cursor-pointer list-none transition-colors hover:text-[#d6d6d6] [&::-webkit-details-marker]:hidden"
      : "cursor-default",
  );
}
