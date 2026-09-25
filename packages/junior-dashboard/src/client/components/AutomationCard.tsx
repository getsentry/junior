import { StatusChip } from "./StatusChip";
import { ArrowUpRight, CircleAlert, Clock3, Workflow } from "lucide-react";
import { Link } from "react-router";
import type { AutomationCard as AutomationCardValue } from "@sentry/junior/api/schema";
import { automationPath } from "../format";

/** Show a saved automation inside a reply, with a preview and a detail link. */
export function AutomationCard({
  card,
}: {
  card: Pick<
    AutomationCardValue,
    "id" | "title" | "instruction" | "trigger" | "warning"
  > & { status?: string };
}) {
  return (
    <section
      aria-label={card.title}
      className="my-1 w-full min-w-0 max-w-[37.5rem] overflow-hidden rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-panel text-sm"
    >
      <div className="flex items-center gap-3 px-4 pb-3 pt-4 md:px-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-dashboard-border bg-dashboard-fill-soft text-cyan-100">
          <Workflow aria-hidden="true" size={18} />
        </span>
        <span className="min-w-0 flex-1 break-words text-base font-semibold text-dashboard-text">
          {card.title}
        </span>
      </div>
      <div className="grid min-w-0 gap-3 px-4 pb-4 md:px-5">
        {card.status && <StatusChip size="compact">{card.status}</StatusChip>}
        <p className="m-0 line-clamp-3 break-words text-sm leading-relaxed text-dashboard-text-muted">
          {card.instruction}
        </p>
        <div className="flex items-start gap-2 text-xs leading-relaxed text-dashboard-text">
          <Clock3
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-dashboard-text-muted"
          />
          <span className="min-w-0 break-words">{card.trigger}</span>
        </div>
        {card.warning ? (
          <div className="flex items-start gap-2 text-xs leading-relaxed text-dashboard-text">
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-amber-500"
            />
            <span className="min-w-0 break-words">{card.warning}</span>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-dashboard-border bg-dashboard-fill-faint px-4 py-3 md:px-5">
        <Link
          to={automationPath(card.id)}
          className="inline-flex shrink-0 items-center gap-2 rounded-sm text-xs font-medium text-cyan-100 no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-dashboard-focus"
        >
          Open automation
          <ArrowUpRight aria-hidden="true" size={14} />
        </Link>
      </div>
    </section>
  );
}
