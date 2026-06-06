import type { ReactNode } from "react";

/** Render the dashboard empty-state block with a warning accent. */
export function EmptyTelemetry(props: { children: ReactNode }) {
  return (
    <div className="relative min-w-0 border border-white/10 bg-[#050505] px-4 py-3 pl-5 text-[0.9rem] leading-relaxed text-[#b8b8b8]">
      <span className="absolute bottom-0 left-0 top-0 w-1 bg-amber-400" />
      {props.children}
    </div>
  );
}
