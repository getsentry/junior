import { Compass } from "lucide-react";

import { cn } from "../styles";

const sizes = {
  avatar: { box: "size-full rounded-md", icon: "size-3.5 md:size-4" },
  header: { box: "size-7 rounded-md", icon: "size-4" },
  intro: { box: "size-11 rounded-xl", icon: "size-6" },
} as const;

/** Mark the Lead: a compass in an accent-tinted square. */
export function LeadMark(props: {
  className?: string;
  size: keyof typeof sizes;
}) {
  const size = sizes[props.size];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center bg-dashboard-accent/15 text-dashboard-accent",
        size.box,
        props.className,
      )}
    >
      <Compass className={size.icon} strokeWidth={2} />
    </span>
  );
}
