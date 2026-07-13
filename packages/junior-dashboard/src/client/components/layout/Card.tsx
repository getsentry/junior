import type { ReactNode } from "react";

import { cn } from "../../styles";

/** Frame elevated dashboard content with the shared translucent surface. */
export function Card(props: {
  children: ReactNode;
  className?: string;
  padding?: "none" | "sm" | "md";
}) {
  const padding = {
    none: "",
    sm: "p-4",
    md: "p-5 sm:p-6",
  }[props.padding ?? "none"];
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border border-white/[0.05] bg-white/[0.02]",
        padding,
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}
