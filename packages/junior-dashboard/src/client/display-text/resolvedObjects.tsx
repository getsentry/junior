import {
  MAX_OBJECT_LINKS,
  objectLinksReportSchema,
  type OwnedObjectAnnotation,
} from "@sentry/junior/api/schema";
import { useQueries, useQuery } from "@tanstack/react-query";
import pLimit from "p-limit";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
  type RefObject,
} from "react";

import { fetchDashboardJson } from "../http";

/** Collects the links that ask for cards in one task into one read. */
type ObjectBatch = {
  load: (url: string) => Promise<OwnedObjectAnnotation | null>;
};

type MessageObjects = {
  /** A link of the message showed or was hovered. */
  asked: boolean;
  batch: ObjectBatch | undefined;
  request: () => void;
};

const NO_OBJECTS: MessageObjects = {
  asked: false,
  batch: undefined,
  request: () => {},
};

const MessageObjectsContext = createContext<MessageObjects>(NO_OBJECTS);

// False inside a row of a list until the row comes near the screen.
const NearScreenContext = createContext(true);

// Object reads that one batch sends at once.
const OBJECT_READS = 4;

// A card is a short-lived read; the API caches it too.
const OBJECT_STALE_MS = 60_000;

async function fetchObjects(urls: readonly string[]) {
  const chunks: string[][] = [];
  for (let start = 0; start < urls.length; start += MAX_OBJECT_LINKS) {
    chunks.push(urls.slice(start, start + MAX_OBJECT_LINKS));
  }
  const reports = await pLimit(OBJECT_READS).map(chunks, (chunk) =>
    fetchDashboardJson(
      objectLinksReportSchema,
      `/api/objects?${new URLSearchParams(chunk.map((url) => ["url", url]))}`,
    ),
  );
  const objects = new Map<string, OwnedObjectAnnotation>();
  for (const report of reports) {
    for (const item of report.objects) {
      if (item.object) objects.set(item.url, item.object);
    }
  }
  return objects;
}

function createObjectBatch(): ObjectBatch {
  let pending:
    | {
        objects: Promise<Map<string, OwnedObjectAnnotation>>;
        urls: Set<string>;
      }
    | undefined;
  return {
    load(url) {
      if (!pending) {
        const urls = new Set<string>();
        // Every query that starts in this task, such as the rows that come
        // on screen together, joins this read.
        const objects = Promise.resolve().then(() => {
          pending = undefined;
          return fetchObjects([...urls]);
        });
        pending = { objects, urls };
      }
      pending.urls.add(url);
      // A link without a card is answered too.
      return pending.objects.then((objects) => objects.get(url) ?? null);
    },
  };
}

// One cache entry for each link, so each link is read once for the whole
// page, whichever provider asks first. `versions.ts` refreshes the cards
// that are on screen through the `object-links` prefix.
function objectLinkQuery(
  batch: ObjectBatch | undefined,
  url: string | undefined,
  enabled: boolean,
) {
  return {
    queryKey: ["object-links", url],
    queryFn: () => batch!.load(url!),
    enabled: enabled && batch !== undefined && url !== undefined,
    staleTime: OBJECT_STALE_MS,
    retry: false,
  };
}

/**
 * Resolve the links of one message together. The first link that scrolls
 * into view or that the reader hovers asks for the cards of every link in
 * the message. Links that ask in the same task, also those of providers
 * inside this one, share one request, and a link that the page already
 * read is not read again.
 */
export function MessageObjectsProvider(props: { children: ReactNode }) {
  const parent = useContext(MessageObjectsContext);
  const [batch] = useState(() => parent.batch ?? createObjectBatch());
  const [asked, setAsked] = useState(false);
  const request = useCallback(() => setAsked(true), []);
  const value = useMemo(
    () => ({ asked, batch, request }),
    [asked, batch, request],
  );
  return (
    <MessageObjectsContext.Provider value={value}>
      {props.children}
    </MessageObjectsContext.Provider>
  );
}

/** Return the link when it can name an object: a web or mail link. */
export function resolvableUrl(href: string | undefined): string | undefined {
  return href && /^(https?|mailto):/i.test(href) ? href : undefined;
}

/**
 * Return the live card of a link when it is the same type of object as the
 * saved one. A viewer who cannot see the object gets a generic page card,
 * which must not replace the saved card.
 */
export function sameTypeCard(
  live: OwnedObjectAnnotation | undefined,
  objectType: string | undefined,
): OwnedObjectAnnotation | undefined {
  return live && (!objectType || live.objectType === objectType)
    ? live
    : undefined;
}

/**
 * Return the object card that the API resolves for a link, for this viewer.
 * The request starts only after `request()`, such as when the link scrolls
 * into view or the reader hovers it, and only near the screen. Until then,
 * and on failure, there is no card. `settled` turns true once an answer
 * covers the link, or its request fails, and stays true for later
 * requests, such as a refetch.
 */
export function useResolvedObject(href: string | undefined): {
  card: OwnedObjectAnnotation | undefined;
  request: () => void;
  settled: boolean;
} {
  const url = resolvableUrl(href);
  const { asked, batch, request } = useContext(MessageObjectsContext);
  const near = useContext(NearScreenContext);
  const { data, isError } = useQuery(
    objectLinkQuery(batch, url, asked && near),
  );
  return {
    card: data ?? undefined,
    request,
    settled: data !== undefined || isError,
  };
}

/** The live card of one link of a list, once its answer came. */
export type ListedObject = {
  card: OwnedObjectAnnotation | undefined;
  /** An answer covers the link, or the request failed. */
  settled: boolean;
};

/**
 * Resolve the links of a list now, such as the rows of one page, in the
 * nearest provider's request. A row inside `NearScreenObjects` waits until
 * it comes near the screen. Return the card of each link.
 */
export function useListedObjects(
  hrefs: readonly (string | undefined)[],
): (href: string | undefined) => ListedObject {
  const { batch } = useContext(MessageObjectsContext);
  const near = useContext(NearScreenContext);
  const urls = [...new Set(hrefs.flatMap((href) => resolvableUrl(href) ?? []))];
  // A plain object, so the answers keep their identity until one changes.
  const answers = useQueries({
    queries: urls.map((url) => objectLinkQuery(batch, url, near)),
    combine: (results) =>
      Object.fromEntries(
        results.map((result, index) => [
          urls[index]!,
          {
            card: result.data ?? undefined,
            settled: result.data !== undefined || result.isError,
          },
        ]),
      ),
  });
  return useCallback(
    (href: string | undefined) => {
      const url = resolvableUrl(href);
      const answer = url ? answers[url] : undefined;
      return {
        card: answer?.card,
        // Outside a provider, or without a link, nothing resolves, so
        // nothing waits.
        settled:
          batch === undefined || url === undefined || Boolean(answer?.settled),
      };
    },
    [answers, batch],
  );
}

/**
 * Ask for the cards of the links inside once the text first shows. Clamped
 * text, such as a row preview, needs this: a link past the clamp never
 * scrolls into view on its own.
 */
export function ResolveWhenVisible(props: {
  block: boolean;
  children: ReactNode;
}) {
  const observe = useWhenVisible(useContext(MessageObjectsContext).request);
  return props.block ? (
    <div className="min-w-0" ref={observe}>
      {props.children}
    </div>
  ) : (
    <span ref={observe}>{props.children}</span>
  );
}

/** Return a ref that calls `onVisible` once, when its element first shows. */
export function useWhenVisible(
  onVisible: () => void,
): RefCallback<HTMLElement> {
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element || typeof IntersectionObserver === "undefined") return;
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          onVisible();
        }
      });
      observer.observe(element);
      return () => observer.disconnect();
    },
    [onVisible],
  );
}

// How far past the edge of its scroll area a row counts as near the screen.
const NEAR_SCREEN_MARGIN = "50% 0px";

function scrollParent(element: Element): Element | null {
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/**
 * Track whether a row of a long list came near the screen. It stays true
 * once it did. Put `ref` on the row; `element` holds the row.
 */
export function useNearScreen<T extends Element>(): {
  element: RefObject<T | null>;
  near: boolean;
  ref: RefCallback<T>;
} {
  const element = useRef<T>(null);
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const ref = useCallback(
    (row: T | null) => {
      element.current = row;
      if (!row || near) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) setNear(true);
        },
        { root: scrollParent(row), rootMargin: NEAR_SCREEN_MARGIN },
      );
      observer.observe(row);
      return () => {
        observer.disconnect();
        element.current = null;
      };
    },
    [near],
  );
  return { element, near, ref };
}

/**
 * Hold back the cards of the links inside until `near`, from
 * `useNearScreen`. The rows that come near the screen together read their
 * cards in one request.
 */
export function NearScreenObjects(props: {
  children: ReactNode;
  near: boolean;
}) {
  return (
    <NearScreenContext.Provider value={props.near}>
      {props.children}
    </NearScreenContext.Provider>
  );
}
