import type { ReactNode } from "react";

import { cn } from "../../styles";

/** Frame elevated dashboard content with the shared translucent surface. */
export function Card(props: {
  as?: "div" | "section";
  children: ReactNode;
  className?: string;
  padding?: "none" | "sm" | "md";
  variant?: "default" | "raised" | "section";
}) {
  const Component = props.as ?? "div";
  const padding = {
    none: "",
    sm: "p-4",
    md: "p-5 sm:p-6",
  }[props.padding ?? "none"];
  const surface =
    props.variant === "section"
      ? "mb-4 border-dashboard-border-subtle bg-dashboard-fill-faint shadow-[0_24px_80px_rgba(0,0,0,0.18)]"
      : props.variant === "raised"
        ? "border-dashboard-border-emphasis bg-dashboard-surface-raised"
        : "border-dashboard-border-subtle bg-dashboard-fill-faint";
  return (
    <Component
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border",
        surface,
        padding,
        props.className,
      )}
    >
      {props.children}
    </Component>
  );
}
