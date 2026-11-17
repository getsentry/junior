import { ChevronRight } from "lucide-react";

import { cn } from "../styles";
import { useInboxUi } from "../uiShell";

/**
 * Render a conversation section label that collapses its rows. The chevron
 * takes the same glyph column and gap as sidebar rows, so the label starts on
 * the row title edge. The new UI's rows use a wider column (`sidebarGrid`).
 */
export function ConversationSectionHeading(props: {
  className?: string;
  collapsed: boolean;
  count: number;
  id?: string;
  label: string;
  onToggle(): void;
}) {
  const inbox = useInboxUi();
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
        className={cn(
          "grid cursor-pointer items-center rounded-sm border-0 bg-transparent p-0 font-[inherit] text-inherit transition-colors hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
          inbox
            ? "grid-cols-[1rem_auto] gap-x-3"
            : "grid-cols-[0.875rem_auto] gap-x-2",
        )}
        onClick={props.onToggle}
        type="button"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 justify-self-center transition-transform motion-reduce:transition-none",
            !props.collapsed && "rotate-90",
          )}
        />
        <span className="flex items-center gap-1">
          {props.label}
          {props.collapsed ? (
            <span className="tabular-nums text-dashboard-text-faint">
              {props.count}
            </span>
          ) : null}
        </span>
      </button>
    </h3>
  );
}
