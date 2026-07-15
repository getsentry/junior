import type { ReactNode } from "react";

/** Render a responsive metric value inside directory rows. */
export function DirectoryMetric(props: { label: string; value: ReactNode }) {
  return (
    <div className="justify-self-end text-right max-md:justify-self-stretch max-md:text-left">
      <div className="mb-1 hidden font-mono text-[0.56rem] uppercase tracking-[0.1em] text-white/25 max-md:block">
        {props.label}
      </div>
      <div className="font-display text-xl font-light leading-none text-white/90 md:font-mono md:text-[0.76rem] md:text-white/65">
        {props.value}
      </div>
    </div>
  );
}
