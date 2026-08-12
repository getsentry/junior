import type { ReactNode } from "react";

import { cn, dashboardContainerClass } from "../../styles";

/** Apply the shared width, spacing, and responsive padding for dashboard pages. */
export function PageLayout(props: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid min-w-0 content-start gap-4 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:gap-6 sm:px-8 sm:py-8 sm:pb-8",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}
