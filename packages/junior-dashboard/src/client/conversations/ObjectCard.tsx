import type { OwnedObjectAnnotation } from "@sentry/junior/api/schema";
import {
  objectFactFields,
  objectPresentation,
} from "@sentry/junior-plugin-api";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { ActorAvatar } from "../components/ActorAvatar";
import { ObjectIcon } from "../components/ObjectIcon";
import { AutomationCard } from "../components/AutomationCard";
import { StatusChip } from "../components/StatusChip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { MessageCard, MessageCardHeader } from "../components/MessageCard";
import { dashboardDisclosureChevronClass } from "../styles";
import { OutboundLink } from "../components/OutboundLink";
import { displayPlainText } from "../display-text/plainText";

// A thumbnail that fails to load does not render.
function Thumbnail({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      alt=""
      className="aspect-video max-h-44 w-full rounded-md border border-dashboard-border object-cover"
      loading="lazy"
      onError={() => setFailed(true)}
      src={src}
    />
  );
}

/**
 * Show the latest saved annotation, or a `live` card that the API resolved
 * for a link. Opening a source is always explicit.
 */
export function ObjectCard({
  card,
  live,
}: {
  card: OwnedObjectAnnotation;
  live?: boolean;
}) {
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
  const presentation = objectPresentation(card);
  const type = card.displayType ?? presentation.label;
  return (
    <MessageCard aria-label={`${type}: ${card.title}`} className="my-1">
      <MessageCardHeader
        icon={
          card.facts?.type === "person" && card.facts.avatarUrl ? (
            <ActorAvatar
              imageUrl={card.facts.avatarUrl}
              name={card.title}
              size="list"
            />
          ) : (
            <ObjectIcon {...card} size={18} />
          )
        }
        meta={[type, card.plugin, card.label === card.title ? "" : card.label]
          .filter(Boolean)
          .join(" · ")}
        title={
          card.url ? (
            <OutboundLink
              href={card.url}
              className="break-words text-base font-semibold text-dashboard-text hover:underline focus-visible:outline-dashboard-focus"
            >
              {card.title}
            </OutboundLink>
          ) : (
            <strong className="break-words text-base text-dashboard-text">
              {card.title}
            </strong>
          )
        }
      />
      <div className="grid min-w-0 gap-4 px-4 pb-4 md:px-5">
        {card.facts?.type === "web_page" && card.facts.thumbnailUrl && (
          <Thumbnail src={card.facts.thumbnailUrl} />
        )}
        {card.facts?.summary && (
          <p className="m-0 max-w-[80ch] break-words text-sm text-dashboard-text-muted">
            {displayPlainText(card.facts.summary)}
          </p>
        )}
        {(card.status || fields.length > 0) && (
          // Facts sit side by side and wrap to a stack in a narrow column.
          <dl className="m-0 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
            {card.status && (
              <div className="min-w-0">
                <dt className="text-xs text-dashboard-text-muted">State</dt>
                <dd className="m-0 mt-1">
                  <StatusChip size="compact" tone={presentation.tone}>
                    {card.status}
                  </StatusChip>
                </dd>
              </div>
            )}
            {fields.map((field) => (
              <div key={field.key} className="min-w-0">
                <dt className="text-xs text-dashboard-text-muted">
                  {field.label}
                </dt>
                <dd className="m-0 mt-1 break-words text-sm text-dashboard-text">
                  {field.href ? (
                    <OutboundLink
                      href={field.href}
                      className="hover:underline focus-visible:outline-dashboard-focus"
                    >
                      {field.value}
                    </OutboundLink>
                  ) : (
                    field.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {card.description && (
          <Collapsible className="min-w-0 border-t border-dashboard-border pt-3">
            <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-xs font-medium text-dashboard-text-muted focus-visible:outline-dashboard-focus">
              <ChevronRight
                aria-hidden="true"
                className={dashboardDisclosureChevronClass}
              />
              More details
            </CollapsibleTrigger>
            <CollapsibleContent hiddenUntilFound>
              <p className="mb-0 mt-3 max-w-[80ch] whitespace-pre-wrap break-words text-sm text-dashboard-text-muted">
                {card.description}
              </p>
            </CollapsibleContent>
          </Collapsible>
        )}
        {card.warning && (
          <p className="m-0 break-words text-xs text-amber-500">
            {card.warning}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-dashboard-border bg-dashboard-fill-faint px-4 py-3 text-xs md:px-5">
        {card.url && (
          <OutboundLink
            href={card.url}
            className="font-medium text-dashboard-text hover:underline focus-visible:outline-dashboard-focus"
          >
            Open {type.toLowerCase()}
          </OutboundLink>
        )}
        {!live && (
          <span className="text-dashboard-text-muted">Latest saved state</span>
        )}
      </div>
    </MessageCard>
  );
}
