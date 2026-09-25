import type { OwnedObjectAnnotation } from "@sentry/junior/api/schema";
import { objectFactFields } from "@sentry/junior-plugin-api";
import {
  ArrowUpRight,
  Box,
  CircleDot,
  GitPullRequest,
  Rocket,
} from "lucide-react";
import { AutomationCard } from "../components/AutomationCard";
import { StatusChip } from "../components/StatusChip";

/** Show the facts saved with this Message. Opening a source is always explicit. */
export function ObjectCard({ card }: { card: OwnedObjectAnnotation }) {
  if (card.plugin === "junior" && card.objectType === "automation") {
    return (
      <AutomationCard
        card={{
          id: card.key,
          title: card.title,
          instruction: card.description ?? "",
          trigger: card.trigger ?? "",
          warning: card.warning ?? null,
          status: card.status,
        }}
      />
    );
  }
  const fields = objectFactFields(card.facts);
  const Icon =
    card.objectType === "code_change"
      ? GitPullRequest
      : card.objectType === "task"
        ? CircleDot
        : card.facts?.type === "deployment"
          ? Rocket
          : Box;
  const type =
    card.displayType ??
    (card.objectType === "code_change"
      ? "Code change"
      : card.objectType === "task"
        ? "Issue"
        : "Item");
  function facts(items: typeof fields) {
    return (
      <dl className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        {items.map((field) => (
          <div key={field.key} className="min-w-0">
            <dt className="text-xs text-dashboard-text-muted">{field.label}</dt>
            <dd className="m-0 mt-1 break-words text-sm text-dashboard-text">
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <section
      aria-label={`${type}: ${card.title}`}
      className="my-1 w-full min-w-0 max-w-[37.5rem] overflow-hidden rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-panel text-sm"
    >
      <div className="flex items-start gap-3 px-4 pb-3 pt-4 md:px-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-dashboard-border bg-dashboard-fill-soft text-dashboard-text-muted">
          <Icon aria-hidden="true" size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 mb-1 break-words text-xs text-dashboard-text-muted">
            {card.plugin} · {card.label}
          </p>
          {card.url ? (
            <a
              href={card.url}
              target="_blank"
              rel="noreferrer"
              className="break-words text-base font-semibold text-dashboard-text hover:underline focus-visible:outline-dashboard-focus"
            >
              {card.title}
            </a>
          ) : (
            <strong className="break-words text-base text-dashboard-text">
              {card.title}
            </strong>
          )}
        </div>
      </div>
      <div className="grid min-w-0 gap-4 px-4 pb-4 md:px-5">
        {card.status && <StatusChip size="compact">{card.status}</StatusChip>}
        {fields.length > 0 && facts(fields)}
        {card.description && (
          <details className="min-w-0 border-t border-dashboard-border pt-3">
            <summary className="cursor-pointer text-xs font-medium text-dashboard-text-muted focus-visible:outline-dashboard-focus">
              More details
            </summary>
            <p className="mb-0 mt-3 whitespace-pre-wrap break-words text-sm text-dashboard-text-muted">
              {card.description}
            </p>
          </details>
        )}
        {card.warning && (
          <p className="m-0 break-words text-xs text-amber-500">
            {card.warning}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-dashboard-border bg-dashboard-fill-faint px-4 py-3 text-xs md:px-5">
        {card.url && (
          <a
            href={card.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 font-medium text-dashboard-text hover:underline focus-visible:outline-dashboard-focus"
          >
            Open {type.toLowerCase()}
            <ArrowUpRight aria-hidden="true" size={14} />
          </a>
        )}
        <span className="text-dashboard-text-muted">Saved snapshot</span>
      </div>
    </section>
  );
}
