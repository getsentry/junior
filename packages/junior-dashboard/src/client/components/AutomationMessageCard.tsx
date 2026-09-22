import { ArrowUpRight, CircleAlert, Workflow } from "lucide-react";
import type { MessageCard } from "@sentry/junior/api/schema";
import { ButtonLink } from "./Button";

/** Show the automation saved at this point in the conversation. */
export function AutomationMessageCard({ card }: { card: MessageCard }) {
  return (
    <section
      aria-label={card.title}
      className="my-1 grid min-w-0 gap-3 rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface p-4"
    >
      <div className="flex items-start gap-2.5">
        <Workflow
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-dashboard-text-muted"
        />
        <div className="min-w-0 flex-1 font-semibold text-dashboard-text">
          {card.title}
        </div>
        <span className="shrink-0 text-xs capitalize text-dashboard-text-muted">
          {card.operation}
        </span>
      </div>
      {card.warning ? (
        <div className="flex items-start gap-2 rounded-md bg-amber-400/10 p-2 text-sm text-amber-200">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{card.warning}</span>
        </div>
      ) : null}
      <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-dashboard-text">
        {card.instruction}
      </p>
      <p className="line-clamp-2 break-words text-xs leading-relaxed text-dashboard-text-muted">
        {card.trigger}
      </p>
      {card.url && card.operation !== "deleted" ? (
        <div>
          <ButtonLink to={card.url} className="h-8 text-xs">
            Open automation{" "}
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </ButtonLink>
        </div>
      ) : null}
      <div className="break-all border-t border-dashboard-border pt-2 text-xs text-dashboard-text-muted">
        Automation ID: <code className="select-all">{card.id}</code>
      </div>
    </section>
  );
}
