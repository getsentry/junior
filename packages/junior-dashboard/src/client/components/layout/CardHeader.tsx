import type { ReactNode } from "react";

import { cn } from "../../styles";
import { SectionTitle } from "./SectionTitle";

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
        "flex flex-wrap items-start justify-between gap-4 border-b border-dashboard-border-subtle px-4 py-4 sm:px-5",
        props.className,
      )}
    >
      <div>
        <SectionTitle>{props.title}</SectionTitle>
        {props.description ? (
          <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
            {props.description}
          </p>
        ) : null}
      </div>
      {props.trailing ? (
        <div className="font-sans text-xs text-dashboard-text-muted">
          {props.trailing}
        </div>
      ) : null}
    </div>
  );
}
