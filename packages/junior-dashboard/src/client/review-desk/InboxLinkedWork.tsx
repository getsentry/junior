import type { OwnedObjectAnnotation } from "@sentry/junior/api/schema";
import { objectPresentation } from "@sentry/junior-plugin-api";
import { useEffect } from "react";
import { objectToneClass } from "../components/ObjectIcon";
import { ConversationSidebarAnnotations } from "../conversations/ConversationMeta";
import { linkStatusLabel } from "../conversations/ConversationLinkedWork";
import {
  MessageObjectsProvider,
  useResolvedObject,
} from "../display-text/DisplayText";
import { cn } from "../styles";
import type { Conversation } from "../types";

type Annotation = NonNullable<Conversation["sidebarAnnotations"]>[number];
type CardAnnotation = Annotation & {
  objectType: NonNullable<Annotation["objectType"]>;
  title: string;
  url: string;
};

/** The most cards, files and links a comfortable Inbox row shows. */
export const MAX_ROW_PREVIEWS = 3;

function isCard(annotation: Annotation): annotation is CardAnnotation {
  return Boolean(annotation.objectType && annotation.title && annotation.url);
}

/**
 * A row's linked work as saved objects, so the links in its summary show
 * their chips. The feed does not name the owning plugin, so the cards show
 * none.
 */
export function linkedWorkObjects(
  annotations: readonly Annotation[],
): OwnedObjectAnnotation[] {
  return annotations.filter(isCard).map((annotation) => ({
    key: annotation.key,
    kind: "object",
    label: annotation.label,
    objectType: annotation.objectType,
    plugin: "",
    status: annotation.status,
    title: annotation.title,
    url: annotation.url,
  }));
}

/** Count the linked-work cards that a comfortable row shows. */
export function linkedWorkCardCount(annotations: Annotation[]): number {
  return Math.min(annotations.filter(isCard).length, MAX_ROW_PREVIEWS);
}

// The plugin key, such as owner/repo#123, when it names the object more
// fully than the chip's short label.
function identity(object: { key: string; label: string }): string {
  return object.key.includes("/") || object.key.includes("#")
    ? object.key
    : object.label;
}

// A quiet card: the title, then the object's name and status in its status
// color. No frame or icon, so the row's text leads.
function WorkCard(props: {
  href: string;
  identity: string;
  imageUrl?: string;
  objectType: OwnedObjectAnnotation["objectType"];
  status?: string;
  title: string;
}) {
  const status = linkStatusLabel(props.status);
  const { tone } = objectPresentation(props);
  return (
    <a
      className="group/card flex w-56 shrink-0 flex-col rounded-md font-sans text-xs no-underline focus-visible:outline-2 focus-visible:outline-dashboard-focus sm:w-auto sm:min-w-48 sm:max-w-72 sm:flex-1"
      data-linked-work-card=""
      href={props.href}
      rel="noreferrer"
      target="_blank"
    >
      {props.imageUrl ? (
        <span className="mb-1.5 block aspect-video overflow-hidden rounded-md bg-dashboard-fill-soft">
          <img
            alt={`Preview of ${props.title}`}
            className="size-full object-cover"
            decoding="async"
            loading="lazy"
            src={props.imageUrl}
          />
        </span>
      ) : null}
      <span className="truncate text-sm font-medium text-dashboard-text group-hover/card:underline">
        {props.title}
      </span>
      <span
        className={cn("truncate", objectToneClass[tone])}
        data-status-tone={tone}
      >
        {/* A person card's label is the name the title already shows. */}
        {[props.identity === props.title ? undefined : props.identity, status]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </a>
  );
}

/**
 * Linked work on a comfortable Inbox row: up to three small cards, newest
 * first, each with its status color, title and preview image. Work that the
 * plugin saved no title or URL for keeps its chip.
 */
export function InboxLinkedWork(props: {
  /** Show every card, with no "+N more". */
  all?: boolean;
  annotations: Annotation[];
}) {
  const cards = props.annotations.filter(isCard);
  const chips = props.annotations.filter((annotation) => !isCard(annotation));
  const shown = props.all ? cards : cards.slice(0, MAX_ROW_PREVIEWS);
  const more = cards.length - shown.length;
  return (
    <div
      aria-label="Linked work"
      className="flex min-w-0 items-center gap-2 overflow-x-auto sm:flex-wrap sm:overflow-visible"
      role="group"
    >
      {shown.map((card) => (
        <WorkCard
          href={card.url}
          identity={identity(card)}
          imageUrl={card.imageUrl}
          key={card.key}
          objectType={card.objectType}
          status={card.status}
          title={card.title}
        />
      ))}
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

// The objects API checks the viewer's access to each link. A link that
// names no object the viewer can see shows nothing.
function LinkCard(props: { url: string }) {
  const { card, request } = useResolvedObject(props.url);
  useEffect(request, [request]);
  if (!card) return null;
  return (
    <WorkCard
      href={card.url ?? props.url}
      identity={identity(card)}
      objectType={card.objectType}
      status={card.status}
      title={card.title}
    />
  );
}

/** Cards for the web links in a Conversation's recent messages. */
export function InboxLinkCards(props: { links: string[] }) {
  // One provider per row: the row's links resolve in one request.
  return (
    <MessageObjectsProvider>
      <div
        aria-label="Links"
        className="flex min-w-0 items-center gap-2 overflow-x-auto empty:hidden sm:flex-wrap sm:overflow-visible"
        role="group"
      >
        {props.links.map((url) => (
          <LinkCard key={url} url={url} />
        ))}
      </div>
    </MessageObjectsProvider>
  );
}
