import {
  MAX_OBJECT_LINKS,
  objectLinksReportSchema,
  type OwnedObjectAnnotation,
} from "@sentry/junior/api/schema";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";

import { fetchDashboardJson } from "../http";

type MessageObjects = {
  register: (url: string) => void;
  request: () => void;
  /** The links of the message, once one of them asked for cards. */
  requested: readonly string[] | undefined;
};

const NO_OBJECTS: MessageObjects = {
  register: () => {},
  request: () => {},
  requested: undefined,
};

const MessageObjectsContext = createContext<MessageObjects>(NO_OBJECTS);

async function fetchObjects(urls: readonly string[]) {
  const chunks: string[][] = [];
  for (let start = 0; start < urls.length; start += MAX_OBJECT_LINKS) {
    chunks.push(urls.slice(start, start + MAX_OBJECT_LINKS));
  }
  const reports = await Promise.all(
    chunks.map((chunk) =>
      fetchDashboardJson(
        objectLinksReportSchema,
        `/api/objects?${new URLSearchParams(chunk.map((url) => ["url", url]))}`,
      ),
    ),
  );
  // Every asked link has an entry, so a link without a card is answered too.
  const objects = new Map<string, OwnedObjectAnnotation | undefined>(
    urls.map((url) => [url, undefined]),
  );
  for (const report of reports) {
    for (const item of report.objects) objects.set(item.url, item.object);
  }
  return objects;
}

/**
 * Resolve the links of one message together. The first link that scrolls
 * into view or that the reader hovers asks for the cards of every link in
 * the message, in one request.
 */
export function MessageObjectsProvider(props: { children: ReactNode }) {
  const urls = useRef(new Set<string>());
  const asked = useRef(false);
  const [requested, setRequested] = useState<readonly string[]>();
  // The set only grows, so an equal size means the same links.
  const update = useCallback(() => {
    setRequested((current) =>
      current?.length === urls.current.size
        ? current
        : [...urls.current].sort(),
    );
  }, []);
  // A link can register after the first request: a streamed message adds
  // links, and a link can show before its effect runs. Ask again with every
  // link, and keep the cards of the last answer meanwhile.
  const register = useCallback(
    (url: string) => {
      if (urls.current.has(url)) return;
      urls.current.add(url);
      if (asked.current) update();
    },
    [update],
  );
  const request = useCallback(() => {
    asked.current = true;
    update();
  }, [update]);
  const value = useMemo(
    () => ({ register, request, requested }),
    [register, request, requested],
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
 * Return the object card that the API resolves for a link, for this viewer.
 * The request starts only after `request()`, such as when the link scrolls
 * into view or the reader hovers it. Until then, and on failure, there is
 * no card. `settled` is true once an answer covers the link, or a request
 * failed. A later request, such as a refetch or one for new links, keeps it
 * true.
 */
export function useResolvedObject(href: string | undefined): {
  card: OwnedObjectAnnotation | undefined;
  request: () => void;
  settled: boolean;
} {
  const url = resolvableUrl(href);
  const { register, request, requested } = useContext(MessageObjectsContext);
  useEffect(() => {
    if (url) register(url);
  }, [register, url]);
  // Every link of the message reads the same query, so they share one
  // request.
  const { data, isError } = useQuery({
    queryKey: ["object-links", requested],
    queryFn: () => fetchObjects(requested!),
    enabled: requested !== undefined,
    placeholderData: keepPreviousData,
    // A card is a short-lived read; the API caches it for a minute too.
    staleTime: 60_000,
    retry: false,
  });
  return {
    card: url ? data?.get(url) : undefined,
    request,
    settled: isError || (url !== undefined && data?.has(url) === true),
  };
}

/** Return a ref that calls `onVisible` once, when its element first shows. */
export function useWhenVisible(
  onVisible: () => void,
): RefCallback<HTMLAnchorElement> {
  return useCallback(
    (element: HTMLAnchorElement | null) => {
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
