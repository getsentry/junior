import type { ReactNode } from "react";

import { cn } from "../styles";

/** Render text with the shadcn `shimmer` utility when `active` is true. */
export function ShimmerText(props: {
  active?: boolean;
  as?: "span" | "strong";
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  // Keep inactive text unwrapped so metric triggers stay the text host for
  // focus/hover tooling and e2e locators.
  if (!props.active && !props.className && !props["aria-label"]) {
    return props.children;
  }
  const className = cn(props.active && "shimmer", props.className);
  if (props.as === "strong") {
    return (
      <strong aria-label={props["aria-label"]} className={className}>
        {props.children}
      </strong>
    );
  }
  return (
    <span aria-label={props["aria-label"]} className={className}>
      {props.children}
    </span>
  );
}
