import type { OwnedObjectAnnotation } from "@sentry/junior/api/schema";
import {
  objectFactFields,
  objectPresentation,
} from "@sentry/junior-plugin-api";
import { CircleAlert } from "lucide-react";

import { ActorAvatar } from "../components/ActorAvatar";
import { ObjectIcon } from "../components/ObjectIcon";
import { OutboundLink } from "../components/OutboundLink";
import { StatusChip } from "../components/StatusChip";
import { ObjectAttachAction } from "./ObjectAttach";
import { ObjectCard } from "./ObjectCard";
import { ObjectImage } from "./ObjectImage";
import { useObjectPreviewImages } from "./objectPreviewImages";

/**
 * Show an object inside a reply as one row, like a Thread card: icon, title,
 * reference, state, and up to two thumbnails. The whole row opens the
 * source. A reply with several objects stays short; the link preview of an
 * object chip still shows the full card.
 */
export function ObjectRow(props: {
  card: OwnedObjectAnnotation;
  live?: boolean;
}) {
  const { card } = props;
  const previews = useObjectPreviewImages(card);
  // An automation has its own card with its prompt and schedule.
  if (card.plugin === "junior" && card.objectType === "automation") {
    return <ObjectCard card={card} live={props.live} />;
  }
  const presentation = objectPresentation(card);
  const type = card.displayType ?? presentation.label;
  // A label that repeats the title says nothing, so a fact such as the
  // site of a web page names the object instead.
  const reference =
    card.label === card.title
      ? (objectFactFields(card.facts)[0]?.value ?? type)
      : card.label;
  const images = [
    ...(card.facts?.type === "web_page" && card.facts.thumbnailUrl
      ? [{ alt: "", src: card.facts.thumbnailUrl, srcSet: undefined }]
      : []),
    ...previews.map((image, index) => ({
      ...image,
      alt: `Description image ${index + 1}`,
    })),
  ].slice(0, 2);
  return (
    <section
      aria-label={`${type}: ${card.title}`}
      className="relative my-1 flex w-full min-w-0 max-w-[37.5rem] items-center gap-2.5 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel px-3 py-2 font-sans text-sm transition-colors hover:border-dashboard-border-emphasis hover:bg-dashboard-surface-hover"
    >
      {card.facts?.type === "person" && card.facts.avatarUrl ? (
        <ActorAvatar
          imageUrl={card.facts.avatarUrl}
          name={card.title}
          size="list"
        />
      ) : (
        <ObjectIcon {...card} size={16} />
      )}
      {card.url ? (
        <OutboundLink
          // The link covers the row, so the whole row opens the source.
          className="min-w-0 truncate font-medium text-dashboard-text no-underline after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-dashboard-focus"
          href={card.url}
          title={card.title}
        >
          {card.title}
        </OutboundLink>
      ) : (
        <span
          className="min-w-0 truncate font-medium text-dashboard-text"
          title={card.title}
        >
          {card.title}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-xs text-dashboard-text-faint">
        {reference}
      </span>
      {card.warning ? (
        // Positioned above the row's link so a pointer gets the tooltip.
        <span
          aria-label={card.warning}
          className="relative shrink-0"
          role="img"
          title={card.warning}
        >
          <CircleAlert aria-hidden className="size-3.5 text-amber-500" />
        </span>
      ) : null}
      {card.status ? (
        <StatusChip
          className="shrink-0"
          size="compact"
          tone={presentation.tone}
        >
          {card.status}
        </StatusChip>
      ) : null}
      {images.map((image) => (
        <ObjectImage
          key={image.src}
          alt={image.alt}
          className="h-6 w-10 shrink-0 rounded"
          src={image.src}
          srcSet={image.srcSet}
        />
      ))}
      {props.live && card.objectType !== "person" ? (
        // Above the row link, so the action does not open the source.
        <span className="relative z-10 shrink-0">
          <ObjectAttachAction card={card} />
        </span>
      ) : null}
    </section>
  );
}
