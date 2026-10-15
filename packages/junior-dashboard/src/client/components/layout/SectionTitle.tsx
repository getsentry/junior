import type { ReactNode } from "react";

/** Render compact section titles that fit inside operational panels. */
export function SectionTitle(props: { children: ReactNode }) {
  return (
    <div className="min-w-0 break-words font-sans text-xs font-medium leading-tight text-dashboard-text-muted">
      {props.children}
    </div>
  );
}
