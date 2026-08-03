import { ShieldCheck } from "lucide-react";

import type { DashboardConfig } from "../../types";
import { Card } from "../../components/layout/Card";
import { SectionIntro } from "../../components/layout/SectionIntro";

type SystemBudgetDescriptions = NonNullable<DashboardConfig["systemBudgets"]>;

function formatLimit(budget: SystemBudgetDescriptions[number]): string {
  if (budget.unit === "milliseconds") {
    const hours = budget.limit / (60 * 60 * 1000);
    return Number.isInteger(hours)
      ? `${hours} hours`
      : `${hours.toFixed(1)} hours`;
  }
  if (budget.unit === "usd") {
    return `$${budget.limit.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })}`;
  }
  return budget.limit.toLocaleString();
}

/** Show the configured budgets that queue work or stop runaway turns. */
export function SystemBudgets(props: { budgets: SystemBudgetDescriptions }) {
  return (
    <section className="grid gap-4" aria-labelledby="system-budgets-title">
      <SectionIntro
        eyebrow="System protections"
        id="system-budgets-title"
        title="System budgets"
      />
      <Card padding="none">
        <div className="grid sm:grid-cols-2 xl:grid-cols-4">
          {props.budgets.map((budget) => (
            <div
              className="border-b border-white/8 p-4 last:border-b-0 xl:border-r xl:border-b-0 xl:last:border-r-0"
              key={budget.name}
            >
              <div className="flex items-center justify-between gap-2 text-emerald-200/70">
                <span className="flex min-w-0 items-center gap-2">
                  <ShieldCheck
                    aria-hidden="true"
                    className="shrink-0"
                    size={14}
                  />
                  <span className="font-mono text-[0.62rem] tracking-[0.08em] uppercase">
                    {budget.label}
                  </span>
                </span>
                <span className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 font-mono text-[0.54rem] tracking-[0.08em] text-dashboard-text-muted uppercase">
                  {budget.outcome === "queue" ? "Queue" : "Stop"}
                </span>
              </div>
              <div className="mt-3 font-display text-2xl text-dashboard-text">
                {formatLimit(budget)}
              </div>
              <p className="mt-1 mb-0 text-xs leading-relaxed text-dashboard-text-muted">
                {budget.description}
              </p>
            </div>
          ))}
        </div>
      </Card>
    </section>
  );
}
