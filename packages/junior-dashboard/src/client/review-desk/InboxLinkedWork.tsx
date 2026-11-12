import { ObjectIcon } from "../components/ObjectIcon";
import { OutboundLink } from "../components/OutboundLink";
import { ConversationSidebarAnnotations } from "../conversations/ConversationMeta";
import { linkStatusLabel } from "../conversations/ConversationLinkedWork";
import type { Conversation } from "../types";

type Annotation = NonNullable<Conversation["sidebarAnnotations"]>[number];
type CardAnnotation = Annotation & {
  objectType: NonNullable<Annotation["objectType"]>;
  title: string;
  url: string;
};

const MAX_CARDS = 3;

function isCard(annotation: Annotation): annotation is CardAnnotation {
  return Boolean(annotation.objectType && annotation.title && annotation.url);
}

// The plugin key, such as owner/repo#123, when it names the object more
// fully than the chip's short label.
function identity(card: CardAnnotation): string {
  return card.key.includes("/") || card.key.includes("#")
    ? card.key
    : card.label;
}

/**
 * Linked work on a comfortable Inbox row: up to three small cards, newest
 * first, each with its status color, title and preview image. Work that the
 * plugin saved no title or URL for keeps its chip.
 */
export function InboxLinkedWork(props: { annotations: Annotation[] }) {
  const cards = props.annotations.filter(isCard);
  const chips = props.annotations.filter((annotation) => !isCard(annotation));
  const more = cards.length - MAX_CARDS;
  return (
    <div
      aria-label="Linked work"
      className="flex min-w-0 items-center gap-2 overflow-x-auto sm:flex-wrap sm:overflow-visible"
      role="group"
    >
      {cards.slice(0, MAX_CARDS).map((card) => {
        const status = linkStatusLabel(card.status);
        return (
          <OutboundLink
            className="flex w-56 shrink-0 flex-wrap items-center gap-x-2 rounded-lg border border-dashboard-border bg-dashboard-fill-faint px-2.5 py-1.5 font-sans text-xs text-dashboard-text-muted no-underline transition-colors hover:border-dashboard-border-strong hover:bg-dashboard-fill-soft focus-visible:outline-2 focus-visible:outline-dashboard-focus sm:w-auto sm:min-w-48 sm:max-w-72 sm:flex-1"
            href={card.url}
            key={card.key}
          >
            {card.imageUrl ? (
              <span className="mb-1.5 block aspect-video basis-full overflow-hidden rounded-md bg-dashboard-fill-soft">
                <img
                  alt={`Preview of ${card.title}`}
                  className="size-full object-cover"
                  decoding="async"
                  loading="lazy"
                  src={card.imageUrl}
                />
              </span>
            ) : null}
            <ObjectIcon
              className="size-4 shrink-0"
              objectType={card.objectType}
              status={card.status}
            />
            <span className="grid min-w-0 flex-1">
              <span className="truncate text-sm font-medium text-dashboard-text">
                {card.title}
              </span>
              <span className="truncate">
                {[identity(card), status].filter(Boolean).join(" · ")}
              </span>
            </span>
          </OutboundLink>
        );
      })}
      {more > 0 ? (
        <span className="shrink-0 text-xs text-dashboard-text-muted">
          +{more} more
        </span>
      ) : null}
      {chips.length > 0 ? (
        <ConversationSidebarAnnotations annotations={chips} />
      ) : null}
    </div>
  );
}
