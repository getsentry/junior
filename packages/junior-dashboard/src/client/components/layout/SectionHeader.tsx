import type { ReactNode } from "react";

/** Render a dashboard section heading row with optional controls. */
export function SectionHeader(props: {
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] bg-black/15 px-4 py-3 max-md:flex-col max-md:items-stretch">
      <div className="min-w-0">{props.children}</div>
      {props.actions ? (
        <div className="shrink-0 max-md:w-full">{props.actions}</div>
      ) : null}
    </div>
  );
}
