import { cn } from "../styles";
import type { VisualStatus } from "../types";

/** Render readable status text while keeping severity color restrained. */
export function StatusBadge(props: {
  label?: string;
  showCompleted?: boolean;
  status: VisualStatus | undefined;
}) {
  const status = props.status ?? "idle";
  if (status === "idle" && !props.showCompleted && !props.label) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        statusBadgeClass(status),
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0",
          status === "active" && "bg-emerald-300",
          status === "failed" && "bg-rose-300",
          status === "idle" && "bg-white/35",
        )}
      />
      {props.label ?? statusLabel(status)}
    </span>
  );
}

function statusLabel(status: VisualStatus): string {
  if (status === "failed") return "error";
  if (status === "idle") return "completed";
  return status;
}

function statusBadgeClass(status: VisualStatus): string {
  return cn(
    "rounded border px-1.5 py-0.5 text-[0.68rem] font-bold uppercase leading-none",
    status === "active" &&
      "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
    status === "failed" && "border-rose-400/25 bg-rose-400/10 text-rose-300",
    status === "idle" && "border-white/10 bg-white/[0.03] text-[#888]",
  );
}
