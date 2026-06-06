import type { ReactNode } from "react";

import { cn } from "../styles";

/** Frame a dashboard content region without leaking CSS class contracts. */
export function Section(props: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        "mb-4 min-w-0 border border-white/10 bg-[#0b0b0b]",
        props.className,
      )}
    >
      {props.children}
    </section>
  );
}
