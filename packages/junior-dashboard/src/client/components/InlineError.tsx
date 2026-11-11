import type { ReactNode } from "react";

import { Alert } from "./ui/alert";

/** Render a compact error message with consistent alert semantics. */
export function InlineError(props: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Alert className={props.className} layout="inline" variant="destructive">
      {props.children}
    </Alert>
  );
}
