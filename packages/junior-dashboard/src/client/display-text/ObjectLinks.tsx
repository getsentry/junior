import { PreviewCard } from "@base-ui/react/preview-card";
import type {
  ConversationDetailReport,
  OwnedObjectAnnotation,
} from "@sentry/junior/api/schema";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { ObjectIcon } from "../components/ObjectIcon";
import { OutboundLink } from "../components/OutboundLink";
import { linkStatusLabel } from "../conversations/ConversationLinkedWork";
import { ObjectCard } from "../conversations/ObjectCard";
import {
  knownObjectsFromAnnotations,
  objectUrlKey,
  textHasStandaloneUrl,
  type KnownObjects,
} from "./knownObjects";

const KnownObjectsContext = createContext<KnownObjects>(new Map());

/**
 * Let display text show the saved object of each link that points to an
 * Annotation of this Conversation. Only saved facts show; nothing is fetched.
 */
export function KnownObjectsProvider(props: {
  annotations: ConversationDetailReport["annotations"];
  children: ReactNode;
}) {
  const objects = useMemo(
    () => knownObjectsFromAnnotations(props.annotations),
    [props.annotations],
  );
  return (
    <KnownObjectsContext.Provider value={objects}>
      {props.children}
    </KnownObjectsContext.Provider>
  );
}

/** Return the saved object that a link points to, when one is known. */
export function useKnownObject(
  href: string | undefined,
): OwnedObjectAnnotation | undefined {
  const objects = useContext(KnownObjectsContext);
  const key = href ? objectUrlKey(href) : undefined;
  return key ? objects.get(key) : undefined;
}

/**
 * Return whether display text shows the full card of the object at `url`, so
 * a surface can hide its own card for that object.
 */
export function useTextShowsObjectCard(
  text: string,
  url: string | undefined,
): boolean {
  const card = useKnownObject(url);
  return Boolean(card && url && textHasStandaloneUrl(text, url));
}

/** Show the object card when the reader hovers or focuses the link. */
export function ObjectLinkPreview(props: {
  card: OwnedObjectAnnotation;
  children: ReactNode;
  className: string;
  href: string;
}) {
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger
        render={<OutboundLink className={props.className} href={props.href} />}
      >
        {props.children}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner
          className="isolate z-50"
          collisionPadding={8}
          sideOffset={6}
        >
          <PreviewCard.Popup className="w-[30rem] max-w-[calc(100vw-1rem)] rounded-xl shadow-2xl shadow-black/40 outline-none">
            <ObjectCard card={props.card} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

/**
 * Show a bare URL in running text as a compact chip: the object icon, its
 * label, and its status. The chip opens the URL and previews the card.
 */
export function ObjectLinkChip(props: {
  card: OwnedObjectAnnotation;
  href: string;
}) {
  const { card } = props;
  const status = linkStatusLabel(card.status);
  return (
    <ObjectLinkPreview
      card={card}
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-dashboard-border bg-dashboard-fill-faint px-1.5 align-bottom text-[0.9em] font-medium leading-6 text-dashboard-text no-underline transition-colors hover:border-dashboard-border-strong hover:bg-dashboard-fill-soft focus-visible:outline-2 focus-visible:outline-dashboard-focus"
      href={props.href}
    >
      <ObjectIcon
        decorative
        facts={card.facts}
        objectType={card.objectType}
        size={14}
        status={card.status}
      />
      <span className="min-w-0 truncate">
        {card.label}
        {status ? (
          <span className="text-dashboard-text-muted"> · {status}</span>
        ) : null}
      </span>
    </ObjectLinkPreview>
  );
}
