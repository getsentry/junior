import type { ReactNode } from "react";

import { Empty, EmptyDescription } from "./ui/empty";

/** Render the dashboard empty-state block with quiet warning context. */
export function EmptyTelemetry(props: { children: ReactNode }) {
  return (
    <Empty>
      <EmptyDescription>{props.children}</EmptyDescription>
    </Empty>
  );
}
