import type { ReactNode } from "react";

/** Render a spacious analytics page heading with optional controls. */
export function PageHeader(props: {
  actions?: ReactNode;
  description: ReactNode;
  title: ReactNode;
}) {
  return (
    <header className="flex min-w-0 items-center justify-between gap-6 border-b border-white/[0.05] pb-4 sm:pb-6 max-md:flex-col max-md:items-stretch">
      <div className="min-w-0">
        <h2 className="m-0 font-display text-3xl font-light leading-none tracking-[-0.03em] text-dashboard-text sm:text-4xl">
          {props.title}
        </h2>
        <div className="mt-2 max-w-2xl font-mono text-xs leading-relaxed text-dashboard-text-muted sm:text-sm">
          {props.description}
        </div>
      </div>
      {props.actions ? <div className="shrink-0">{props.actions}</div> : null}
    </header>
  );
}
