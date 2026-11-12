import { Lock } from "lucide-react";

/** Shared redacted placeholder used by message and resource transcript rows. */
export function RedactedMarker() {
  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-md bg-dashboard-fill-soft px-2 py-0.5 font-sans text-xs leading-5 text-dashboard-text-muted">
      <Lock aria-hidden="true" size={12} strokeWidth={2} />
      Hidden
    </span>
  );
}
