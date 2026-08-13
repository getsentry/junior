import type { ReactNode } from "react";

import { cn } from "../styles";

/** Shared running-text shimmer used by live metrics and in-progress tool names. */
export const shimmerTextClassName =
  "animate-[junior-text-shimmer_1.6s_linear_infinite] bg-[linear-gradient(90deg,var(--color-dashboard-shimmer-edge)_0%,var(--color-dashboard-shimmer-soft)_40%,var(--color-dashboard-shimmer-highlight)_50%,var(--color-dashboard-shimmer-soft)_60%,var(--color-dashboard-shimmer-edge)_100%)] bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none";

/** Render text with the dashboard running shimmer when `active` is true. */
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
  const className = cn(props.active && shimmerTextClassName, props.className);
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
