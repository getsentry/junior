import type { ReactNode } from "react";

/**
 * A small bordered card of labeled facts, as used in details rails. Pass
 * `action` for one link or button beside the title.
 */
export function FactSection(props: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <section
      aria-label={props.title}
      className="grid min-w-0 gap-2.5 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel p-3"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <h3 className="m-0 font-sans text-xs font-medium text-dashboard-text-muted">
          {props.title}
        </h3>
        {props.action ? (
          <div className="shrink-0 text-xs">{props.action}</div>
        ) : null}
      </div>
      {props.children}
    </section>
  );
}

/** Rows of label and value inside a FactSection. */
export function FactList(props: { children: ReactNode }) {
  return (
    <dl className="m-0 grid min-w-0 gap-2 text-xs leading-snug">
      {props.children}
    </dl>
  );
}

/** One label on the left and its value on the right. */
export function Fact(props: { children: ReactNode; label: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4">
      <dt className="shrink-0 text-dashboard-text-muted">{props.label}</dt>
      <dd className="m-0 min-w-0 break-words text-right tabular-nums text-dashboard-text">
        {props.children}
      </dd>
    </div>
  );
}
