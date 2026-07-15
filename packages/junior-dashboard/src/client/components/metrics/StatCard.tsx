import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Card } from "../layout/Card";

/** Present one primary reporting value with quiet supporting context. */
export function StatCard(props: {
  detail?: string;
  icon: LucideIcon;
  label: string;
  value: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <Card className="relative p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="font-mono text-[0.65rem] font-medium uppercase tracking-[0.14em] text-white/40">
          {props.label}
        </div>
        <Icon aria-hidden="true" className="text-amber-400/55" size={15} />
      </div>
      <div className="mt-4 font-display text-3xl font-light leading-none tracking-[-0.04em] text-white sm:text-[2.1rem]">
        {props.value}
      </div>
      {props.detail ? (
        <div className="mt-2 font-mono text-[0.68rem] leading-relaxed text-white/35">
          {props.detail}
        </div>
      ) : null}
    </Card>
  );
}
