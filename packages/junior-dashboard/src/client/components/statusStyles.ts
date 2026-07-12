import type { VisualStatus } from "../types";

/** Map conversation health to the shared left-border severity accent. */
export function statusBorderClass(status: VisualStatus): string {
  if (status === "active") return "border-l-emerald-400";
  if (status === "failed") return "border-l-rose-400";
  return "border-l-white/25";
}
