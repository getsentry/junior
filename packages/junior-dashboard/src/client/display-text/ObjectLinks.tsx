import type {
  ConversationDetailReport,
  OwnedObjectAnnotation,
} from "@sentry/junior/api/schema";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { HoverPreview } from "../components/ui/hover-preview";
import { ObjectCard } from "../conversations/ObjectCard";
import {
  SavedObjectsContext,
  savedObjectsFromAnnotations,
} from "../conversations/savedObjects";
import {
  knownObjectsFromAnnotations,
  objectUrlKey,
  textHasStandaloneUrl,
  type KnownObjects,
} from "./knownObjects";
import { ANCHOR_CLASS } from "./links";
import { PersonMention } from "./people";

// Fits most live cards, such as a pull request or a task. A taller card
// scrolls in its body.
const RESERVED_PREVIEW_HEIGHT_CLASS = "h-[min(22rem,var(--available-height))]";

type KnownObjectsValue = {
  objects: KnownObjects;
  /** URL keys of Annotations that save only a link, with no facts. */
  links: ReadonlySet<string>;
};

const KnownObjectsContext = createContext<KnownObjectsValue>({
  links: new Set(),
  objects: new Map(),
});

/**
 * Let display text show the saved object of each link that points to an
 * Annotation of this Conversation. Only saved facts show; nothing is fetched.
 */
export function KnownObjectsProvider(props: {
  annotations: ConversationDetailReport["annotations"];
  children: ReactNode;
}) {
  const value = useMemo(() => {
    // The first Annotation for a URL wins, as in `knownObjectsFromAnnotations`.
    const kinds = new Map<string, string>();
    for (const annotation of props.annotations ?? []) {
      const key = annotation.url ? objectUrlKey(annotation.url) : undefined;
      if (key && !kinds.has(key)) kinds.set(key, annotation.kind);
    }
    return {
      links: new Set(
        [...kinds].flatMap(([key, kind]) =>
          kind === "resource_link" ? [key] : [],
        ),
      ),
      objects: knownObjectsFromAnnotations(props.annotations),
    };
  }, [props.annotations]);
  const saved = useMemo(
    () => savedObjectsFromAnnotations(props.annotations),
    [props.annotations],
  );
  return (
    <KnownObjectsContext.Provider value={value}>
      <SavedObjectsContext.Provider value={saved}>
        {props.children}
      </SavedObjectsContext.Provider>
    </KnownObjectsContext.Provider>
  );
}

/**
 * Return the saved object that a link points to, when one is known.
 * `linkOnly` is true when the Annotation saves only the link, so a live card
 * shows more.
 */
export function useKnownObject(href: string | undefined): {
  card: OwnedObjectAnnotation | undefined;
  linkOnly: boolean;
} {
  const { links, objects } = useContext(KnownObjectsContext);
  const key = href ? objectUrlKey(href) : undefined;
  return {
    card: key ? objects.get(key) : undefined,
    linkOnly: key ? links.has(key) : false,
  };
}

/**
 * Return whether display text shows the full card of the object at `url`, so
 * a surface can hide its own card for that object.
 */
export function useTextShowsObjectCard(
  text: string,
  url: string | undefined,
): boolean {
  const { card } = useKnownObject(url);
  return Boolean(
    card && url && !mediaThumbnail(card) && textHasStandaloneUrl(text, url),
  );
}

// A long title would fill a sentence. The card shows all of it.
const MAX_LINK_TITLE_CHARS = 80;

/**
 * Return the link text of an object: its title, then its short label, such
 * as "Fix the retry (#3035)". A repository prefix is dropped from the label.
 * A message has no title of its own, so its link shows where it is.
 */
function objectLinkText(card: OwnedObjectAnnotation): string {
  if (card.objectType === "message") return card.label;
  const hash = card.label.lastIndexOf("#");
  const label =
    hash > 0 && card.label.slice(0, hash).includes("/")
      ? card.label.slice(hash)
      : card.label;
  const title =
    card.title.length > MAX_LINK_TITLE_CHARS
      ? `${card.title.slice(0, MAX_LINK_TITLE_CHARS - 1).trimEnd()}…`
      : card.title;
  return labelRepeatsTitle(card) ? title : `${title} (${label})`;
}

// A link without a title of its own uses its label as the title, and a long
// title can be cut short as the label, with or without "…". Neither label
// adds anything.
function labelRepeatsTitle(card: OwnedObjectAnnotation): boolean {
  const label = card.label.endsWith("…") ? card.label.slice(0, -1) : card.label;
  return card.title.startsWith(label);
}

/** Return the thumbnail of a video or image page, the only part it shows alone. */
export function mediaThumbnail(
  card: OwnedObjectAnnotation,
): string | undefined {
  return card.facts?.type === "web_page" && card.facts.media
    ? card.facts.thumbnailUrl
    : undefined;
}

/**
 * Show the object card when the reader hovers or focuses the link. With
 * `reserveHeight`, the card has a fixed height, so it does not jump when a
 * live card replaces a saved one.
 */
export function ObjectLinkPreview(props: {
  card: OwnedObjectAnnotation;
  children: ReactNode;
  className: string;
  href: string;
  live?: boolean;
  reserveHeight?: boolean;
}) {
  return (
    <HoverPreview
      className={
        props.reserveHeight ? RESERVED_PREVIEW_HEIGHT_CLASS : undefined
      }
      // The hover card is the frame, so it stays whole while the card scrolls.
      content={
        <ObjectCard
          card={props.card}
          className="my-0 rounded-none border-0"
          fill={props.reserveHeight}
          live={props.live}
        />
      }
      // Running text links carry no outbound icon, so a paragraph of links
      // reads as text.
      trigger={
        <a
          className={props.className}
          href={props.href}
          rel="noreferrer"
          target="_blank"
        />
      }
    >
      {props.children}
    </HoverPreview>
  );
}

/**
 * Show a bare URL in running text as a plain link with the object title. The
 * link opens the URL and previews the card.
 */
export function ObjectTitleLink(props: {
  card: OwnedObjectAnnotation;
  href: string;
  live?: boolean;
  reserveHeight?: boolean;
}) {
  return (
    <ObjectLinkPreview
      card={props.card}
      className={ANCHOR_CLASS}
      href={props.href}
      live={props.live}
      reserveHeight={props.reserveHeight}
    >
      {objectLinkText(props.card)}
    </ObjectLinkPreview>
  );
}

/**
 * Show the thumbnail of a video or image page that stands alone on its line.
 * The image opens the URL and previews the card. A thumbnail that fails to
 * load shows the title link instead.
 */
export function ObjectThumbnailLink(props: {
  card: OwnedObjectAnnotation;
  href: string;
  live?: boolean;
  src: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ObjectTitleLink {...props} />;
  return (
    <ObjectLinkPreview
      card={props.card}
      className="block w-fit max-w-full rounded-md focus-visible:outline-2 focus-visible:outline-dashboard-focus"
      href={props.href}
      live={props.live}
    >
      <img
        alt={props.card.title}
        className="aspect-video w-80 max-w-full rounded-md border border-dashboard-border object-cover"
        loading="lazy"
        onError={() => setFailed(true)}
        src={props.src}
      />
    </ObjectLinkPreview>
  );
}

/**
 * Show a bare URL to a person in running text as a GitHub-style mention:
 * the photo, then `@Name` as a plain link that previews the card.
 */
export function PersonLink(props: {
  card: OwnedObjectAnnotation;
  href: string;
  live?: boolean;
  reserveHeight?: boolean;
}) {
  const { card } = props;
  const facts = card.facts?.type === "person" ? card.facts : undefined;
  return (
    <PersonMention avatarUrl={facts?.avatarUrl} email={facts?.email}>
      <ObjectLinkPreview
        card={card}
        className={ANCHOR_CLASS}
        href={props.href}
        live={props.live}
        reserveHeight={props.reserveHeight}
      >
        @{card.label}
      </ObjectLinkPreview>
    </PersonMention>
  );
}
