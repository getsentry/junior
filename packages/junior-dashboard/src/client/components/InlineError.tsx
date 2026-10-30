import type { ReactNode } from "react";

import { cn } from "../styles";
import { Alert } from "./ui/alert";

/** Render a compact error message with consistent alert semantics. */
export function InlineError(props: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Alert
      className={cn(
        "block rounded-none border-0 bg-transparent p-0 text-rose-300",
        props.className,
      )}
      variant="destructive"
    >
      {props.children}
    </Alert>
  );
}
