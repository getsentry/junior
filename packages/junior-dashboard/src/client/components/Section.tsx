import type { ReactNode } from "react";

import { cn } from "../styles";

/** Frame a dashboard content region without leaking CSS class contracts. */
export function Section(props: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        "mb-4 min-w-0 overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.025] shadow-[0_24px_80px_rgba(0,0,0,0.18)]",
        props.className,
      )}
    >
      {props.children}
    </section>
  );
}
