import { useRef, type CSSProperties, type ReactNode } from "react";

import { useMobileViewportHeight } from "../../mobileViewport";
import { cn } from "../../styles";

/**
 * Own the dashboard visual-viewport shell.
 *
 * Only this component may pin the conversation workspace to visualViewport
 * geometry and write the related CSS variables / body scroll lock.
 */
export function VisualViewportShell(props: {
  children: ReactNode;
  className?: string;
  /** Pin the shell to the mobile visual viewport (conversation routes). */
  enabled: boolean;
  style?: CSSProperties;
}) {
  const shellRef = useRef<HTMLElement | null>(null);
  useMobileViewportHeight(shellRef, props.enabled);

  return (
    <main
      className={cn(
        "grid font-sans text-dashboard-text",
        props.enabled
          ? "fixed inset-x-0 top-[var(--dashboard-viewport-offset-top,0px)] h-[var(--dashboard-viewport-height,100dvh)] max-h-[var(--dashboard-viewport-height,100dvh)] min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden overscroll-none md:relative md:inset-auto md:h-dvh md:max-h-none md:overscroll-auto"
          : "relative min-h-screen grid-rows-[auto_1fr]",
        props.className,
      )}
      ref={shellRef}
      style={props.style}
    >
      {props.children}
    </main>
  );
}
