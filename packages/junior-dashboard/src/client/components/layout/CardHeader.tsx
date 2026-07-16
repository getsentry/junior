import type { ReactNode } from "react";

import { cn } from "../../styles";

/** Render a consistent card heading, supporting copy, and optional trailing content. */
export function CardHeader(props: {
  title: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.06] px-4 py-4 sm:px-5",
        props.className,
      )}
    >
      <div>
        <h3 className="m-0 font-mono text-[0.68rem] font-medium uppercase tracking-[0.14em] text-white/60">
          {props.title}
        </h3>
        {props.description ? (
          <p className="mt-1 mb-0 font-mono text-[0.68rem] leading-relaxed text-white/50">
            {props.description}
          </p>
        ) : null}
      </div>
      {props.trailing ? (
        <div className="font-mono text-[0.64rem] text-white/55">
          {props.trailing}
        </div>
      ) : null}
    </div>
  );
}
