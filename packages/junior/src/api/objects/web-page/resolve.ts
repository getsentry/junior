/**
 * The catch-all link type: a card for any public web page. It reads the
 * oEmbed fields of a known provider first, then the Open Graph and Twitter
 * card meta tags of the page. Every fetch goes through the address guard.
 */
import { createHash } from "node:crypto";
import type { ObjectAnnotation } from "@sentry/junior-plugin-api";
import { getDashboardOrigin } from "@/chat/dashboard-link";
import { imagePath } from "@/chat/images/ids";
import { getStateAdapter } from "@/chat/state/adapter";
import { createCache } from "@/chat/state/cache";
import { guardedFetch } from "@/net/guarded-fetch";
import { webPageObjectCard } from "../cards";
import type { ObjectLinkType } from "../link-types";
import { parsePageMeta } from "./meta";
import { oembedRequestUrl, parseOembedResponse } from "./oembed";

/** The largest oEmbed response or page start that Junior reads. */
export const MAX_WEB_PAGE_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 3_000;
const USER_AGENT = "junior-bot/0.1 (link preview)";
// Keep a card for an hour, or for the oEmbed `cache_age` within bounds.
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MIN_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
// Retry a page without a card soon, but not on each page load.
const FAILURE_TTL_MS = 5 * 60 * 1000;
// The card shows a thumbnail at up to 320 CSS pixels, so 2x is 640.
const THUMBNAIL_WIDTH = 640;
// A longer image address does not fit in a signed image id.
const MAX_THUMBNAIL_URL_CHARS = 2000;

type Page = {
  author?: string;
  cacheAgeSeconds?: number;
  description?: string;
  image?: string;
  siteName?: string;
  title?: string;
};

function fetchText(url: string, accept: string, truncate: boolean) {
  return guardedFetch({
    accept,
    maxBytes: MAX_WEB_PAGE_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
    truncate,
    url,
    userAgent: USER_AGENT,
  });
}

async function readOembed(url: URL): Promise<Page | undefined> {
  const request = oembedRequestUrl(url);
  if (!request) return undefined;
  const fetched = await fetchText(request, "application/json", false);
  if ("failure" in fetched) return undefined;
  const oembed = parseOembedResponse(fetched.bytes.toString("utf8"));
  if (!oembed?.title) return undefined;
  return {
    author: oembed.author_name,
    cacheAgeSeconds: oembed.cache_age,
    image: oembed.thumbnail_url,
    siteName: oembed.provider_name,
    title: oembed.title,
  };
}

async function readMetaTags(
  url: URL,
): Promise<(Page & { pageUrl: string }) | undefined> {
  const fetched = await fetchText(
    url.href,
    "text/html,application/xhtml+xml",
    true,
  );
  if ("failure" in fetched) return undefined;
  // Read only HTML. Junior does not guess the type of other bodies.
  if (
    !/^\s*(text\/html|application\/xhtml\+xml)\b/i.test(
      fetched.contentType ?? "",
    )
  ) {
    return undefined;
  }
  return {
    ...parsePageMeta(fetched.bytes.toString("utf8")),
    pageUrl: fetched.url,
  };
}

// Serve a thumbnail only through the Junior image route.
function thumbnailPath(image: string | undefined, base: string) {
  if (!image || !URL.canParse(image, base)) return undefined;
  const url = new URL(image, base);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.href.length > MAX_THUMBNAIL_URL_CHARS) return undefined;
  return imagePath({ ref: url.href, source: "public" }, THUMBNAIL_WIDTH);
}

async function loadWebPage(
  url: URL,
): Promise<{ value: ObjectAnnotation | null; ttlMs: number }> {
  const oembed = await readOembed(url);
  const page = oembed
    ? { ...oembed, pageUrl: url.href }
    : await readMetaTags(url);
  if (!page?.title) return { value: null, ttlMs: FAILURE_TTL_MS };
  const ttlMs = page.cacheAgeSeconds
    ? Math.min(Math.max(page.cacheAgeSeconds * 1000, MIN_TTL_MS), MAX_TTL_MS)
    : DEFAULT_TTL_MS;
  return {
    value: webPageObjectCard({
      author: page.author,
      description: page.description,
      siteName: page.siteName ?? url.hostname,
      thumbnailUrl: thumbnailPath(page.image, page.pageUrl),
      title: page.title,
      url: url.href,
    }),
    ttlMs,
  };
}

/**
 * Return the card of a public web page. A public page is the same for every
 * viewer, so one cached card per URL serves them all. Junior's own dashboard
 * pages get no card.
 */
async function resolveWebPageLink(
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  if (url.origin === getDashboardOrigin()) return undefined;
  if (url.username || url.password) return undefined;
  const key = createHash("sha256").update(url.href).digest("hex");
  const card = await createCache(getStateAdapter(), "web-pages").getOrLoad(
    key,
    () => loadWebPage(url),
  );
  return card ?? undefined;
}

/**
 * The least specific link type. Any plugin or core link type that matches a
 * URL wins over it.
 */
export function webPageLinkType(): ObjectLinkType {
  return {
    // The resolver keeps one card per URL for every viewer.
    cacheCards: false,
    filters: [{ scheme: "https" }, { scheme: "http" }],
    objectType: "web_page",
    owner: "junior",
    resolve: (_viewer, url) => resolveWebPageLink(url),
  };
}
