import type { MouseEvent, ReactNode } from "react";

import { cn } from "../styles";

const interactiveSelector =
  "a, button, input, select, textarea, [role='button'], [role='link']";

/** Render a consistently interactive row while preserving nested controls. */
export function SelectableRow(props: {
  children: ReactNode;
  className?: string;
  onSelect(): void;
  selected: boolean;
}) {
  function handleClick(event: MouseEvent<HTMLDivElement>) {
    if (
      event.target instanceof Element &&
      event.target.closest(interactiveSelector)
    ) {
      return;
    }
    props.onSelect();
  }

  return (
    <div
      className={cn(
        "group cursor-pointer transition-colors",
        props.selected
          ? "bg-cyan-300/[0.045]"
          : "hover:bg-dashboard-fill-muted focus-within:bg-dashboard-fill-muted",
        props.className,
      )}
      onClick={handleClick}
    >
      {props.children}
    </div>
  );
}
