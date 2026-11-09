import type { ReactNode } from "react";

import { AnchorHeading } from "../../components/layout/AnchorHeading";
import { cn } from "../../styles";

function sectionAnchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Keep section headings and fields aligned without nested form cards. The
 * read view and the editor use the same sections, so editing stays in place.
 */
export function AutomationFormSection(props: {
  title: string;
  detail?: string;
  /** Mark a section with unsaved edits. */
  changed?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "grid min-w-0 gap-5 border-t border-dashboard-border-emphasis py-8 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-10",
        props.changed &&
          "-ml-4 pl-4 shadow-[inset_2px_0_0_var(--color-dashboard-accent)] sm:-ml-5 sm:pl-5",
      )}
    >
      <div>
        <AnchorHeading
          anchor={sectionAnchor(props.title)}
          className="m-0 font-display text-lg font-medium"
          title={props.title}
        />
        {props.changed ? (
          <p className="mt-1 mb-0 text-xs text-dashboard-accent-text">
            Unsaved changes
          </p>
        ) : null}
        {props.detail ? (
          <p className="mt-2 mb-0 text-sm leading-relaxed text-dashboard-text-muted">
            {props.detail}
          </p>
        ) : null}
      </div>
      <div className="grid min-w-0 content-start gap-5">{props.children}</div>
    </section>
  );
}
