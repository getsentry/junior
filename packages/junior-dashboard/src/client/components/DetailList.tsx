import type { ReactNode } from "react";

import { cn } from "../styles";

/** Group labeled details into the shared dashboard definition-list surface. */
export function DetailList(props: { children: ReactNode; className?: string }) {
  return (
    <dl
      className={cn(
        "grid gap-px overflow-hidden rounded border border-white/[0.06] bg-white/[0.055]",
        props.className,
      )}
    >
      {props.children}
    </dl>
  );
}

/** Render one labeled value inside a DetailList. */
export function Detail(props: {
  children: ReactNode;
  label: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0 bg-[#09090b] px-3 py-3">
      <dt className="font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
        {props.label}
      </dt>
      <dd
        className={cn(
          "mt-1.5 ml-0 break-words text-sm leading-relaxed text-dashboard-text",
          props.valueClassName,
        )}
      >
        {props.children}
      </dd>
    </div>
  );
}
