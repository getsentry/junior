import type { ReactNode } from "react";

import { cn } from "../styles";

/** Render a compact error message with consistent alert semantics. */
export function InlineError(props: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn("m-0 text-sm text-rose-300", props.className)}
      role="alert"
    >
      {props.children}
    </p>
  );
}
