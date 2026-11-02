import { ChevronRight } from "lucide-react";

import { cn } from "../styles";

/** Render a conversation section label that collapses its rows. */
export function ConversationSectionHeading(props: {
  className?: string;
  collapsed: boolean;
  count: number;
  id?: string;
  label: string;
  onToggle(): void;
}) {
  return (
    <h3
      className={cn(
        "m-0 font-sans text-xs font-medium text-dashboard-text-muted",
        props.className,
      )}
      id={props.id}
    >
      <button
        aria-expanded={!props.collapsed}
        className="flex cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent p-0 font-[inherit] text-inherit transition-colors hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
        onClick={props.onToggle}
        type="button"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 transition-transform motion-reduce:transition-none",
            !props.collapsed && "rotate-90",
          )}
        />
        {props.label}
        {props.collapsed ? (
          <span className="tabular-nums text-dashboard-text-faint">
            {props.count}
          </span>
        ) : null}
      </button>
    </h3>
  );
}
