import type { ReactNode } from "react";

/** Render compact section titles that fit inside operational panels. */
export function SectionTitle(props: { children: ReactNode }) {
  return (
    <div className="min-w-0 break-words text-[1.05rem] font-bold leading-tight tracking-normal">
      {props.children}
    </div>
  );
}
