import { ObjectIcon } from "./ObjectIcon";
import { objectPresentation } from "@sentry/junior-plugin-api";
import { StatusChip } from "./StatusChip";
import { ArrowUpRight, CircleAlert, Clock3 } from "lucide-react";
import { Link } from "react-router";
import type { AutomationCard as AutomationCardValue } from "@sentry/junior/api/schema";
import { DisplayText } from "../display-text/DisplayText";
import { Item, ItemContent, ItemMedia } from "./ui/item";
import { cn } from "@dashboard/lib/utils";
import { MessageCard } from "./MessageCard";
import { automationPath } from "../format";

/** Show a saved automation inside a reply, with a preview and a detail link. */
export function AutomationCard({
  card,
  className,
}: {
  card: Pick<
    AutomationCardValue,
    "id" | "title" | "instruction" | "trigger" | "warning"
  > & { status?: string | undefined };
  className?: string | undefined;
}) {
  return (
    <MessageCard aria-label={card.title} className={cn("my-1", className)}>
      <Item className="items-center" size="card">
        <ItemMedia className="text-dashboard-accent-text" variant="icon">
          <ObjectIcon objectType="automation" status={card.status} size={18} />
        </ItemMedia>
        <ItemContent className="block break-words text-base font-semibold text-dashboard-text">
          {card.title}
        </ItemContent>
      </Item>
      <div className="grid min-w-0 gap-3 px-4 pb-4 md:px-5">
        {card.status && (
          <StatusChip
            size="compact"
            tone={
              objectPresentation({
                objectType: "automation",
                status: card.status,
              }).tone
            }
          >
            {card.status}
          </StatusChip>
        )}
        <p className="m-0 line-clamp-3 break-words text-sm leading-relaxed text-dashboard-text-muted">
          <DisplayText inline text={card.instruction} />
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
          className="inline-flex shrink-0 items-center gap-2 rounded-sm text-xs font-medium text-dashboard-accent-text no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-dashboard-focus"
        >
          Open automation
          <ArrowUpRight aria-hidden="true" size={14} />
        </Link>
      </div>
    </MessageCard>
  );
}
