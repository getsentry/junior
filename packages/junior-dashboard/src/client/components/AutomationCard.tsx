import { ArrowUpRight, CircleAlert, Workflow } from "lucide-react";
import { Link } from "react-router";
import type { AutomationCard as AutomationCardValue } from "@sentry/junior/api/schema";
import { automationPath } from "../format";

/** Show the saved object, with instructions and controls on its detail page. */
export function AutomationCard({ card }: { card: AutomationCardValue }) {
  if (card.operation === "deleted") return null;

  return (
    <section
      aria-label={card.title}
      className="my-1 w-full min-w-0 max-w-lg rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-panel text-sm"
    >
      <div className="flex items-start gap-3 p-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashboard-border bg-dashboard-surface-raised">
          <Workflow
            aria-hidden="true"
            className="size-4 text-dashboard-text-muted"
          />
        </div>
        <div className="min-w-0 flex-1">
          <Link
            to={automationPath(card.id)}
            className="group flex items-start gap-2 rounded-sm font-semibold leading-5 text-dashboard-text no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-dashboard-focus"
          >
            <span className="min-w-0 flex-1 break-words">{card.title}</span>
            <ArrowUpRight
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-dashboard-text-muted group-hover:text-dashboard-text"
            />
          </Link>
          <p className="mt-1.5 break-words text-sm leading-5 text-dashboard-text-muted">
            {card.trigger}
          </p>
        </div>
      </div>
      {card.warning ? (
        <div className="flex items-start gap-2 border-t border-dashboard-border px-4 py-3 text-sm leading-5 text-dashboard-text">
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-amber-500"
          />
          <span className="min-w-0 break-words">{card.warning}</span>
        </div>
      ) : null}
    </section>
  );
}
