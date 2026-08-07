import type { ReactNode } from "react";

/** Introduce a dashboard section with a consistent title and description. */
export function SectionIntro(props: {
  className?: string;
  description?: ReactNode;
  id?: string;
  title: ReactNode;
}) {
  return (
    <div className={props.className}>
      <h2
        className="m-0 font-display text-xl font-medium tracking-[-0.02em] text-dashboard-text"
        id={props.id}
      >
        {props.title}
      </h2>
      {props.description ? (
        <p className="mt-1.5 mb-0 max-w-2xl font-mono text-xs leading-relaxed text-dashboard-text-muted">
          {props.description}
        </p>
      ) : null}
    </div>
  );
}
