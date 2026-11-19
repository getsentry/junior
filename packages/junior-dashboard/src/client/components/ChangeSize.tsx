import type { CodeChangeSize } from "@sentry/junior-plugin-api";

import { codeChangeSize } from "../codeChangeSize";
import { cn } from "../styles";

/**
 * A code change's size, such as `+1.2k −340 · 12 files`, in small muted
 * text unless `className` sets the type. The tooltip and the accessible
 * name give the exact counts. Renders nothing when no part is known.
 */
export function ChangeSize(props: {
  className?: string;
  size: CodeChangeSize | undefined;
}) {
  const size = codeChangeSize(props.size);
  if (!size) return null;
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap font-sans font-normal tabular-nums",
        props.className ?? "text-xs text-dashboard-text-muted",
      )}
      data-code-change-size=""
      title={size.label}
    >
      <span aria-hidden>{size.short}</span>
      <span className="sr-only">{size.label}</span>
    </span>
  );
}
