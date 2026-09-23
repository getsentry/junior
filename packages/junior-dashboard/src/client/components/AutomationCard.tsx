import { ArrowUpRight, CircleAlert, Workflow } from "lucide-react";
import { Link } from "react-router";
import type { AutomationCard as AutomationCardValue } from "@sentry/junior/api/schema";
import { automationPath } from "../format";

/** Show a compact saved object. Full instructions belong on its detail page. */
export function AutomationCard({ card }: { card: AutomationCardValue }) {
  return (
    <section
      aria-label={card.title}
      className="my-1 w-full min-w-0 max-w-lg rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-panel text-sm"
    >
      <div className="flex items-start gap-3 p-3">
        <Workflow
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-dashboard-text-muted"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            {card.operation === "deleted" ? (
              <span className="min-w-0 flex-1 break-words font-semibold text-dashboard-text">
                {card.title}
              </span>
            ) : (
              <Link
                to={automationPath(card.id)}
                className="group flex min-w-0 flex-1 items-start gap-1.5 rounded-sm font-semibold text-dashboard-text no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-dashboard-focus"
              >
                <span className="min-w-0 break-words">{card.title}</span>
                <ArrowUpRight
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-dashboard-text-muted group-hover:text-dashboard-text"
                />
              </Link>
            )}
            <span className="shrink-0 text-xs capitalize leading-relaxed text-dashboard-text-muted">
              {card.operation}
            </span>
          </div>
          <p className="mt-1 break-words text-xs leading-relaxed text-dashboard-text-muted">
            {card.trigger}
          </p>
          {card.warning ? (
            <div className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-dashboard-text">
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0 text-amber-500"
              />
              <span className="min-w-0 break-words">{card.warning}</span>
            </div>
          ) : null}
          <div className="mt-2 text-xs leading-relaxed text-dashboard-text-muted">
            <span className="sr-only">Automation ID: </span>
            <code className="block select-all truncate" title={card.id}>
              {card.id}
            </code>
          </div>
        </div>
      </div>
    </section>
  );
}
