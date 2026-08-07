import type { ReactNode } from "react";

/** Introduce a dashboard section with a consistent eyebrow, title, and description. */
export function SectionIntro(props: {
  className?: string;
  description?: ReactNode;
  eyebrow: ReactNode;
  id?: string;
  title: ReactNode;
}) {
  return (
    <div className={props.className}>
      <div className="font-mono text-xs uppercase tracking-[0.16em] text-cyan-200/65">
        {props.eyebrow}
      </div>
      <h2
        className="mt-1 mb-0 font-display text-xl font-medium tracking-[-0.02em] text-dashboard-text"
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
