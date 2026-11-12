import {
  MAX_OBJECT_LINKS,
  objectLinksReportSchema,
  type OwnedObjectAnnotation,
} from "@sentry/junior/api/schema";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { fetchDashboardJson } from "../http";

type Waiter = {
  reject: (error: unknown) => void;
  resolve: (object: OwnedObjectAnnotation | null) => void;
};

type LoadObject = (url: string) => Promise<OwnedObjectAnnotation | null>;

async function fetchObjects(urls: readonly string[]) {
  const query = new URLSearchParams(urls.map((url) => ["url", url]));
  const report = await fetchDashboardJson(
    objectLinksReportSchema,
    `/api/objects?${query}`,
  );
  return new Map(report.objects.map((item) => [item.url, item.object]));
}

// Links that ask in one frame share one request.
function createObjectLoader(): LoadObject {
  let pending = new Map<string, Waiter[]>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    const batch = pending;
    pending = new Map();
    flushTimer = undefined;
    const urls = [...batch.keys()];
    for (let start = 0; start < urls.length; start += MAX_OBJECT_LINKS) {
      const chunk = urls.slice(start, start + MAX_OBJECT_LINKS);
      fetchObjects(chunk).then(
        (objects) => {
          for (const url of chunk) {
            for (const waiter of batch.get(url) ?? []) {
              waiter.resolve(objects.get(url) ?? null);
            }
          }
        },
        (error: unknown) => {
          for (const url of chunk) {
            for (const waiter of batch.get(url) ?? []) waiter.reject(error);
          }
        },
      );
    }
  };
  return (url) =>
    new Promise((resolve, reject) => {
      pending.set(url, [...(pending.get(url) ?? []), { reject, resolve }]);
      flushTimer ??= setTimeout(flush, 16);
    });
}

// One loader for each query client, so the batch lives as long as its cache.
const loaders = new WeakMap<QueryClient, LoadObject>();

function objectLoader(client: QueryClient): LoadObject {
  const existing = loaders.get(client);
  if (existing) return existing;
  const loader = createObjectLoader();
  loaders.set(client, loader);
  return loader;
}

/** Return the link when it can name an object: a web or mail link. */
export function resolvableUrl(href: string | undefined): string | undefined {
  return href && /^(https?|mailto):/i.test(href) ? href : undefined;
}

/**
 * Return the object card that the API resolves for a link, for this viewer.
 * The request starts only after `request()`, such as when the link scrolls
 * into view or the reader hovers it. Until then, and on failure, there is
 * no card.
 */
export function useResolvedObject(href: string | undefined): {
  card: OwnedObjectAnnotation | undefined;
  request: () => void;
} {
  const url = resolvableUrl(href);
  const [requested, setRequested] = useState(false);
  const { data } = useQuery({
    queryKey: ["object-links", url],
    queryFn: ({ client }) => objectLoader(client)(url!),
    enabled: requested && url !== undefined,
    // A card is a short-lived read; the API caches it for a minute too.
    staleTime: 60_000,
    retry: false,
  });
  const request = useCallback(() => setRequested(true), []);
  return { card: data ?? undefined, request };
}

/** Call `onVisible` once, when the element first scrolls into view. */
export function useWhenVisible(
  onVisible: () => void,
  enabled: boolean,
): (element: Element | null) => void {
  const [element, setElement] = useState<Element | null>(null);
  useEffect(() => {
    if (!enabled || !element || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        onVisible();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, enabled, onVisible]);
  return setElement;
}
