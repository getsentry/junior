import type { ReactNode } from "react";

/** Render compact section titles that fit inside operational panels. */
export function SectionTitle(props: { children: ReactNode }) {
  return (
    <div className="min-w-0 break-words font-mono text-xs font-medium uppercase leading-tight tracking-[0.14em] text-dashboard-text-muted">
      {props.children}
    </div>
  );
}
