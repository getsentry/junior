import type { ReactNode } from "react";

import { formatDuration } from "../time";

/** Render a compact human-readable duration. */
export function Duration(props: {
  fallback?: ReactNode;
  value: number | undefined;
}) {
  return <>{formatDuration(props.value) || props.fallback || null}</>;
}
