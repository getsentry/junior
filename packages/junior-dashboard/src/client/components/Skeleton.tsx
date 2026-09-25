import type { ElementType } from "react";

import { cn } from "../styles";

/** Hide one content placeholder from assistive technology. */
export function Skeleton(props: { as?: ElementType; className?: string }) {
  const Component = props.as ?? "div";
  return (
    <Component
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded bg-dashboard-fill-soft motion-reduce:animate-none",
        props.className,
      )}
    />
  );
}
