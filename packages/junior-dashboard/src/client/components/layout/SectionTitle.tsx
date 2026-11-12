import type { ReactNode } from "react";

/**
 * Title one section of a page, card, or panel. Field labels and subsection
 * labels stay small and muted, so this title must stand out from them.
 */
export function SectionTitle(props: { children: ReactNode }) {
  return (
    <h3 className="m-0 min-w-0 break-words font-sans text-sm font-semibold leading-tight text-dashboard-text">
      {props.children}
    </h3>
  );
}
