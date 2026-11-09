import type { ReactNode } from "react";

import { AnchorHeading } from "./AnchorHeading";

const TITLE_CLASS =
  "m-0 font-display text-xl font-medium tracking-[-0.02em] text-dashboard-text";

/**
 * Introduce a dashboard section with a consistent title and description.
 * Pass `anchor` to let people link to the section.
 */
export function SectionIntro(props: {
  anchor?: string;
  className?: string;
  description?: ReactNode;
  title: string;
}) {
  return (
    <div className={props.className}>
      {props.anchor ? (
        <AnchorHeading
          anchor={props.anchor}
          className={TITLE_CLASS}
          title={props.title}
        />
      ) : (
        <h2 className={TITLE_CLASS}>{props.title}</h2>
      )}
      {props.description ? (
        <p className="mt-1.5 mb-0 max-w-2xl font-sans text-xs leading-relaxed text-dashboard-text-muted">
          {props.description}
        </p>
      ) : null}
    </div>
  );
}
