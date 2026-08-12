import type { ReactNode } from "react";

import { cn } from "../../styles";

/** Frame elevated dashboard content with the shared translucent surface. */
export function Card(props: {
  as?: "div" | "section";
  children: ReactNode;
  className?: string;
  padding?: "none" | "sm" | "md";
  variant?: "default" | "section";
}) {
  const Component = props.as ?? "div";
  const padding = {
    none: "",
    sm: "p-4",
    md: "p-5 sm:p-6",
  }[props.padding ?? "none"];
  const surface =
    props.variant === "section"
      ? "mb-4 border-dashboard-border-subtle bg-dashboard-fill-soft shadow-[0_24px_80px_var(--color-dashboard-shadow-soft)]"
      : "border-dashboard-border-faint bg-dashboard-fill-faint";
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
