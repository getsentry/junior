import type { ReactNode } from "react";

import { cn } from "../styles";

/**
 * Own composer bottom padding and dock chrome.
 *
 * Bottom pad comes only from `--dashboard-composer-dock-padding` written by
 * `VisualViewportShell` / `useMobileViewportHeight`. Callers must not invent
 * `env(safe-area-inset-bottom)` math here.
 */
export function ComposerDock(props: {
  children: ReactNode;
  className?: string;
  /** Queue / authorization chrome above the composer. */
  above?: ReactNode;
  /**
   * Reply docks cap height on mobile when mailbox chrome is present.
   * Create docks stay content-sized.
   */
  variant?: "create" | "reply";
}) {
  const variant = props.variant ?? "reply";

  return (
    <div
      className={cn(
        // Shared dock pad is the only bottom geometry owner.
        "min-w-0 shrink-0 pb-[var(--dashboard-composer-dock-padding,0.375rem)]",
        variant === "reply"
          ? "flex w-full min-h-0 max-h-[min(calc(var(--dashboard-viewport-height,100dvh)*0.55),24rem)] flex-col overflow-hidden bg-[#050507] px-2 pt-1.5 md:max-h-none md:overflow-visible md:px-7 md:pt-3 md:pb-3"
          : "px-2 pt-1.5 md:px-8 md:pt-2 md:pb-8",
        props.className,
      )}
    >
      {props.above ? (
        <div className="min-h-0 min-w-0 shrink overflow-y-auto overscroll-contain md:overflow-visible">
          {props.above}
        </div>
      ) : null}
      <div className="min-w-0 shrink-0">{props.children}</div>
    </div>
  );
}
