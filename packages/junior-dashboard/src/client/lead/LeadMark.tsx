import { Compass } from "lucide-react";

/** Mark the Lead's transcript avatar: a compass in an accent-tinted square. */
export function LeadMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-full shrink-0 place-items-center rounded-md bg-dashboard-accent/15 text-dashboard-accent"
    >
      <Compass className="size-3.5 md:size-4" strokeWidth={2} />
    </span>
  );
}
