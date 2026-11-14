import type { OwnedObjectAnnotation } from "@sentry/junior/api/schema";
import {
  objectFactFields,
  objectPresentation,
} from "@sentry/junior-plugin-api";
import { ChevronRight } from "lucide-react";
import { cn } from "@dashboard/lib/utils";
import { ActorAvatar } from "../components/ActorAvatar";
import { ObjectIcon } from "../components/ObjectIcon";
import { AutomationCard } from "../components/AutomationCard";
import { Sparkline } from "../components/charts/Sparkline";
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
import { formatRelativeTime, formatTime } from "../format";
import { ObjectAttachAction } from "./ObjectAttach";
import { ObjectImage } from "./ObjectImage";
import { objectSource } from "./objectSource";
import { useSavedObject } from "./savedObjects";

// Its type and its core plugin tell the viewer nothing, and the label of a
// web page is its title.
function cardMeta(card: OwnedObjectAnnotation, type: string): string {
  if (card.objectType === "web_page") return webPageMeta(card) ?? type;
  return (
    [
      type,
      objectSource(card.plugin),
      // A label that repeats the title or the type says nothing new.
      [card.title, type].includes(card.label) ? "" : card.label,
    ]
      .filter(Boolean)
      .join(" · ") || type
  );
}

/** Name a web page by its site, then its author, such as "YouTube · Sentry". */
export function webPageMeta(card: OwnedObjectAnnotation): string | undefined {
  const author =
    card.facts?.type === "web_page" ? card.facts.author : undefined;
  return [webPageSite(card), author].filter(Boolean).join(" · ") || undefined;
}

function webPageSite(card: OwnedObjectAnnotation): string | undefined {
  if (card.facts?.type === "web_page" && card.facts.siteName) {
    return card.facts.siteName;
  }
  if (!card.url || !URL.canParse(card.url)) return undefined;
  return new URL(card.url).hostname.replace(/^www\./, "");
}

/**
 * Show the full card of the latest saved annotation, or a `live` card that
 * the API resolved for a link: images, facts, and details. A link preview
 * shows it; a reply shows `ObjectRow`. Opening a source is always explicit.
 * A live card can attach its object to the Conversation. A saved card tells
 * when Junior fetched its facts. With `fill`, the card fills the height of
 * its container and its body scrolls.
 */
export function ObjectCard({
  card,
  fill,
  live,
}: {
  card: OwnedObjectAnnotation;
  fill?: boolean;
  live?: boolean;
}) {
  const saved = useSavedObject(card);
  const images = saved.previewImages;
  const fetchedAt = live ? undefined : saved.updatedAt;
  const attachable = live && card.objectType !== "person";
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
  // The header already names the site and author of a web page, and the
  // chart caption shows its range.
  const fields = objectFactFields(card.facts).filter((field) =>
    card.facts?.type === "web_page"
      ? field.key !== "siteName" && field.key !== "author"
      : card.facts?.type !== "chart" || field.key !== "range",
  );
  const presentation = objectPresentation(card);
  const type = card.displayType ?? presentation.label;
  return (
    <MessageCard
      aria-label={`${type}: ${card.title}`}
      className={cn("my-1", fill && "my-0 flex h-full flex-col")}
    >
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
        meta={cardMeta(card, type)}
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
      <div
        className={cn(
          "grid min-w-0 gap-4 px-4 pb-4 md:px-5",
          fill && "min-h-0 flex-1 content-start overflow-y-auto",
        )}
      >
        {(card.facts?.type === "document" || card.facts?.type === "web_page") &&
          card.facts.thumbnailUrl && (
            <ObjectImage
              className="aspect-video max-h-44 w-full"
              src={card.facts.thumbnailUrl}
            />
          )}
        {images.length > 0 && (
          // Screenshots often come as a before and after pair, side by side.
          <div className="grid grid-cols-2 gap-2">
            {images.map((image, index) => (
              <ObjectImage
                key={image.src}
                alt={`Description image ${index + 1}`}
                className="aspect-video w-full"
                src={image.src}
                srcSet={image.srcSet}
              />
            ))}
          </div>
        )}
        {card.facts?.summary && (
          <p className="m-0 max-w-[80ch] break-words text-sm text-dashboard-text-muted">
            {displayPlainText(card.facts.summary)}
          </p>
        )}
        {card.facts?.type === "task" && card.facts.trend && (
          <Sparkline
            label={card.facts.trend.label}
            series={[card.facts.trend]}
          />
        )}
        {card.facts?.type === "chart" && (
          <Sparkline
            display={card.facts.display}
            label={card.facts.range}
            series={card.facts.series}
            tall
          />
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
      {(card.url || fetchedAt || attachable) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-dashboard-border bg-dashboard-fill-faint px-4 py-3 text-xs md:px-5">
          {card.url && (
            <OutboundLink
              href={card.url}
              className="font-medium text-dashboard-text hover:underline focus-visible:outline-dashboard-focus"
            >
              Open {type.toLowerCase()}
            </OutboundLink>
          )}
          {fetchedAt && (
            <time
              className="text-dashboard-text-muted"
              dateTime={fetchedAt}
              title={formatTime(fetchedAt)}
            >
              Last fetched {formatRelativeTime(fetchedAt)}
            </time>
          )}
          {attachable && <ObjectAttachAction card={card} />}
        </div>
      )}
    </MessageCard>
  );
}
