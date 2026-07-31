import type { ReactNode } from "react";

/** Render a responsive metric value inside directory rows. */
export function DirectoryMetric(props: { label: string; value: ReactNode }) {
  return (
    <div className="justify-self-end text-right max-md:justify-self-stretch max-md:text-left">
      <div
        aria-hidden="true"
        className="mb-1 hidden font-mono text-[0.56rem] uppercase tracking-[0.1em] text-dashboard-text-muted max-md:block"
      >
        {props.label}
      </div>
      <div className="font-display text-xl font-light leading-none text-dashboard-text md:font-mono md:text-[0.76rem] md:text-dashboard-text-muted">
        <span className="sr-only">{props.label}: </span>
        {props.value}
      </div>
    </div>
  );
}
