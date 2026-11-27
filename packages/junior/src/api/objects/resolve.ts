import { mapBounded } from "@/chat/fan-out";
import { createHash } from "node:crypto";
import {
  type CacheEntry,
  objectAnnotationSchema,
  ownedObjectAnnotationSchema,
  type ObjectLinkContext,
  type ObjectLinkPrefetchOutcome,
  type ObjectType,
  type OwnedObjectAnnotation,
  type PluginCache,
  type PluginEgress,
  type PluginObjectLinkDefinition,
  type PluginRegistration,
  type PluginViewerMcp,
  type User,
} from "@sentry/junior-plugin-api";
import { getDashboardLinkFilter } from "@/chat/dashboard-link";
import { credentialContextForActor } from "@/chat/credentials/context";
import { getDb } from "@/chat/db";
import { webActorFromUser } from "@/chat/conversations/web-input";
import { createPluginEgress } from "@/chat/egress/plugin";
import { imagePath } from "@/chat/images/ids";
import { logException } from "@/chat/logging";
import { createViewerMcp } from "@/chat/mcp/viewer";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import { replaceAnnotationSubjectId } from "@/chat/plugins/annotations";
import { createPluginCache } from "@/chat/plugins/cache";
import { createPluginLogger } from "@/chat/plugins/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { createCache } from "@/chat/state/cache";
import { canViewAutomationLink, resolveAutomationLink } from "./automation";
import {
  canViewConversationLink,
  resolveConversationLink,
} from "./conversation";
import {
  assertNoObjectLinkConflicts,
  findObjectLinkType,
  linkTypeName,
  type ObjectLinkRead,
  type ObjectLinkType,
} from "./link-types";
import { resolvePersonByAccount, resolvePersonLink } from "./person";
import {
  resolveSlackMessageLink,
  SLACK_MESSAGE_LINK_FILTER,
} from "./slack-message";
import { webPageLinkType } from "./web-page/resolve";

/** A card is a short-lived read. A changed object shows within this time. */
export const OBJECT_LINK_TTL_MS = 60_000;

// A link type without its own `httpCache` keeps each response this long,
// and shows the last one when a read fails.
const DEFAULT_HTTP_CACHE = { staleIfError: true, ttlMs: OBJECT_LINK_TTL_MS };

// Links resolve outside a Turn, so no person is the credential subject. This
// system Actor gets only credentials that a plugin owns, never the viewer's.
// Each plugin checks that the viewer may see an object before it returns it.
const OBJECT_LINK_SYSTEM_ACTOR = {
  platform: "system",
  name: "object-link",
} as const;

// A cache-only read must not reach a provider, so a plugin that tries fails.
const noProviderCall = () =>
  Promise.reject(new Error("A cache-only card read called a provider"));
const NO_PROVIDER_EGRESS: PluginEgress = { fetch: noProviderCall };
const NO_PROVIDER_MCP: PluginViewerMcp = { callTool: noProviderCall };

function coreLinkTypes(): ObjectLinkType[] {
  // Slack runtime is in core until Slack is a plugin.
  const slack: ObjectLinkType = {
    // Slack reads do not go through plugin egress.
    cacheCards: true,
    // The card read checks channel access inside the viewer's Slack
    // workspace, so it shares one Slack installation with the check.
    canView: async () => true,
    filters: [SLACK_MESSAGE_LINK_FILTER],
    objectTypes: ["message"],
    owner: "junior",
    resolve: resolveSlackMessageLink,
  };
  const automations = getDashboardLinkFilter("/automations/*");
  const conversations = getDashboardLinkFilter("/conversations/*");
  const people = getDashboardLinkFilter("/people/*");
  // Any other public page. Its filters are the least specific.
  const webPages = webPageLinkType();
  // These links need the dashboard: each card links to a dashboard page.
  if (!automations || !conversations || !people) return [slack, webPages];
  return [
    slack,
    webPages,
    {
      // The card reads the Automation from the database, so a change, such
      // as a pause, shows at once.
      canView: canViewAutomationLink,
      filters: [automations],
      cacheOnlyReads: true,
      label: () => "Automation",
      objectTypes: ["automation"],
      owner: "junior",
      resolve: resolveAutomationLink,
    },
    {
      cacheCards: true,
      cacheOnlyReads: true,
      canView: canViewConversationLink,
      filters: [conversations],
      objectTypes: ["conversation"],
      owner: "junior",
      resolve: resolveConversationLink,
    },
    {
      // Person cards read the identity cache. A link or unlink clears it.
      cacheOnlyReads: true,
      // Every signed-in viewer sees the People pages.
      canView: async () => true,
      filters: [people, { scheme: "mailto" }],
      objectTypes: ["person"],
      owner: "junior",
      resolve: (_viewer, url) => resolvePersonLink(url),
    },
  ];
}

/**
 * Keep a plugin's cache from saving anything after one of its HTTP reads
 * served a stale body. A saved copy would look fresh, so later cards would
 * hide their age.
 */
function cardReadCache(
  cache: PluginCache,
  servedStale: () => boolean,
): PluginCache {
  return {
    get: async (key, options) => await cache.get(key, options),
    async getOrLoad<T>(
      key: string,
      load: () => Promise<CacheEntry<T>>,
      options?: { refresh?: boolean },
    ): Promise<T> {
      return await cache.getOrLoad(
        key,
        async () => {
          const entry = await load();
          return servedStale() ? { value: entry.value } : entry;
        },
        options,
      );
    },
    async update<T>(
      key: string,
      next: (current: T | undefined) => CacheEntry<T> | undefined,
    ): Promise<void> {
      await cache.update<T>(key, (current) =>
        servedStale() ? undefined : next(current),
      );
    },
    delete: async (key) => await cache.delete(key),
  };
}

function objectLinkContext(
  name: string,
  link: PluginObjectLinkDefinition,
  viewer: User,
  prefetched?: ObjectLinkPrefetchOutcome,
  read: ObjectLinkRead = {},
): ObjectLinkContext {
  const cached = link.httpCache
    ? { staleIfError: link.httpCache.staleIfError ?? true, ...link.httpCache }
    : DEFAULT_HTTP_CACHE;
  let servedStale = false;
  const onStale = (storedAtMs: number) => {
    servedStale = true;
    read.onStale?.(storedAtMs);
  };
  // A read that must count a change of access at once asks the provider
  // each time. A 304 still proves that the credential may read it.
  const httpCache = {
    ...(read.now ? { staleIfError: false, ttlMs: 0 } : cached),
    onStale,
  };
  return {
    ...(prefetched ? { prefetchOutcome: prefetched } : undefined),
    cache: cardReadCache(
      createPluginCache(name, read.onStale),
      () => servedStale,
    ),
    db: getDb(),
    egress: createPluginEgress({
      credentialContext: credentialContextForActor(OBJECT_LINK_SYSTEM_ACTOR),
      httpCache,
      // A card is optional. It must never ask anyone to authorize.
      pluginAuth: { async handleAuthRequired() {} },
    }),
    // The width of web page thumbnails, so every card looks the same.
    imagePath: (ref, version) => imagePath({ ref, source: name }, 640, version),
    findPerson: resolvePersonByAccount,
    log: createPluginLogger(name),
    plugin: { name },
    viewer,
    // The viewer's User id is the subject of their dashboard connections.
    // Only that subject's own OAuth token is used.
    viewerEgress: createPluginEgress({
      credentialContext: credentialContextForActor(webActorFromUser(viewer)),
      httpCache,
      pluginAuth: { async handleAuthRequired() {} },
      userOAuthOnly: true,
    }),
    viewerMcp: createViewerMcp(name, viewer.id),
    replaceSubjectId: (subject) =>
      replaceAnnotationSubjectId(getDb(), { ...subject, plugin: name }),
    ...(read.cacheOnly
      ? {
          cacheOnly: true,
          egress: NO_PROVIDER_EGRESS,
          viewerEgress: NO_PROVIDER_EGRESS,
          viewerMcp: NO_PROVIDER_MCP,
        }
      : undefined),
  };
}

function pluginLinkTypes(plugin: PluginRegistration): ObjectLinkType[] {
  const name = plugin.manifest.name;
  return (plugin.objectLinks ?? []).map((link) => ({
    ...(link.cacheCards ? { cacheCards: true } : undefined),
    ...(link.cacheOnlyReads ? { cacheOnlyReads: true } : undefined),
    canView: (viewer, url, prefetched, read) =>
      link.canView(
        objectLinkContext(name, link, viewer, prefetched, read),
        url,
      ),
    filters: link.filters,
    ...(link.label ? { label: link.label } : undefined),
    objectTypes: link.objectTypes,
    owner: name,
    ...(link.prefetch
      ? {
          prefetch: async (viewer: User, urls: URL[]) =>
            await link.prefetch?.(objectLinkContext(name, link, viewer), urls),
        }
      : undefined),
    readTool: link.readTool,
    resolve: (viewer, url, prefetched, read) =>
      link.resolve(
        objectLinkContext(name, link, viewer, prefetched, read),
        url,
      ),
    ...(link.webPageFallback ? { webPageFallback: true } : undefined),
  }));
}

/**
 * Return the link types of core and the plugins. Throws when two of them
 * claim the same URLs, so app setup fails at load time.
 */
export function readObjectLinkTypes(
  plugins: readonly PluginRegistration[] = getPlugins(),
): ObjectLinkType[] {
  const linkTypes = [...coreLinkTypes(), ...plugins.flatMap(pluginLinkTypes)];
  assertNoObjectLinkConflicts(linkTypes);
  return linkTypes;
}

/**
 * Return the object type of the link type that claims a URL, such as
 * `code_change` for a pull request link from the GitHub plugin. The plugin
 * that owns the link type decides; core only reads its filters. A link type
 * that can open more than one type, such as a GitHub issue URL that can open
 * a pull request, names no type from the URL alone.
 */
export function readLinkObjectType(
  url: string,
  linkTypes: readonly ObjectLinkType[] = readObjectLinkTypes(),
): ObjectType | undefined {
  if (!URL.canParse(url)) return undefined;
  const objectTypes = findObjectLinkType(linkTypes, new URL(url))?.objectTypes;
  return objectTypes?.length === 1 ? objectTypes[0] : undefined;
}

type ResolvedObjectLink = {
  linkType: ObjectLinkType;
  object: OwnedObjectAnnotation;
};

async function resolveWithLinkType(
  linkType: ObjectLinkType,
  viewer: User,
  url: URL,
  prefetched?: ObjectLinkPrefetchOutcome,
  read: Pick<ObjectLinkRead, "cacheOnly" | "now"> = {},
): Promise<ResolvedObjectLink | null> {
  if (!(await linkType.canView(viewer, url, prefetched, read))) {
    // The web page card reads only what anyone can read signed out. A
    // cache-only read shows only the stored title and link instead.
    return linkType.webPageFallback && !read.cacheOnly
      ? await resolveWithLinkType(webPageLinkType(), viewer, url)
      : null;
  }
  // The card is as old as the oldest entry that served after its TTL.
  let fetchedAtMs: number | undefined;
  const resolved = await linkType.resolve(viewer, url, prefetched, {
    ...read,
    onStale: (storedAtMs) => {
      fetchedAtMs = Math.min(fetchedAtMs ?? storedAtMs, storedAtMs);
    },
  });
  if (!resolved) return null;
  const object = objectAnnotationSchema.parse(resolved);
  if (!linkType.objectTypes.includes(object.objectType)) {
    throw new Error(
      `Link type "${linkTypeName(linkType)}" returned a ${object.objectType} object.`,
    );
  }
  return {
    linkType,
    object: ownedObjectAnnotationSchema.parse({
      ...object,
      ...(fetchedAtMs === undefined
        ? undefined
        : { fetchedAt: new Date(fetchedAtMs).toISOString() }),
      plugin: linkType.owner,
    }),
  };
}

/**
 * Resolve one link for one viewer without the card cache, and with each
 * HTTP read asking the provider, so a change of access counts at once.
 * Returns nothing when no link type claims the URL or the viewer cannot see
 * the object.
 */
export async function resolveObjectLinkNow(
  viewer: User,
  url: URL,
): Promise<ResolvedObjectLink | undefined> {
  const linkType = findObjectLinkType(readObjectLinkTypes(), url);
  if (!linkType) return undefined;
  return (
    (await resolveWithLinkType(linkType, viewer, url, undefined, {
      now: true,
    })) ?? undefined
  );
}

/**
 * Return whether a link type of `plugin` claims the URL, lets the viewer
 * see it now, and reads an object there. A missing or deleted object does
 * not count. Neither does the web page card: it shows what anyone can read
 * signed out, not what the viewer can see.
 */
export async function viewerCanViewPluginLink(
  viewer: User,
  url: URL,
  plugin: string,
): Promise<boolean> {
  const linkType = findObjectLinkType(readObjectLinkTypes(), url);
  const read = { now: true } as const;
  return (
    linkType?.owner === plugin &&
    (await linkType.canView(viewer, url, undefined, read)) &&
    Boolean(await linkType.resolve(viewer, url, undefined, read))
  );
}

// Each link type loads its URLs in one call, so a page of cards does not
// read the provider once per card. A failed prefetch only costs the
// per-card reads. Returns the outcome of each URL that its link type
// reported, for that URL's own resolve.
async function prefetchLinks(
  viewer: User,
  links: ReadonlyArray<{ linkType: ObjectLinkType; parsed: URL }>,
): Promise<
  Map<ObjectLinkType, ReadonlyMap<string, ObjectLinkPrefetchOutcome>>
> {
  const byType = new Map<ObjectLinkType, URL[]>();
  for (const { linkType, parsed } of links) {
    if (linkType.prefetch)
      byType.set(linkType, [...(byType.get(linkType) ?? []), parsed]);
  }
  const outcomes = new Map<
    ObjectLinkType,
    ReadonlyMap<string, ObjectLinkPrefetchOutcome>
  >();
  await mapBounded(byType, async ([linkType, typeUrls]) => {
    try {
      const typeOutcomes = await linkType.prefetch?.(viewer, typeUrls);
      if (typeOutcomes) outcomes.set(linkType, typeOutcomes);
    } catch (error) {
      logException(error, "object_link.prefetch.failed", {
        "app.plugin.name": linkType.owner,
      });
    }
  });
  return outcomes;
}

/**
 * Resolve links to object cards for one viewer. A link without a link type,
 * without access, or with a failed read gets no card. Nothing is saved on a
 * Conversation. `cacheOnly` reads, for a page load or a poll, make
 * no provider call: they show only what the caches hold.
 */
export async function resolveObjectLinks(
  viewer: User,
  urls: readonly string[],
  read: Pick<ObjectLinkRead, "cacheOnly"> = {},
): Promise<Array<{ object: OwnedObjectAnnotation; url: string }>> {
  const linkTypes = readObjectLinkTypes();
  const links = [...new Set(urls)].flatMap((url) => {
    const parsed = URL.canParse(url) ? new URL(url) : undefined;
    const linkType = parsed && findObjectLinkType(linkTypes, parsed);
    return parsed && linkType ? [{ linkType, parsed, url }] : [];
  });
  // A prefetch loads from the provider, so a cache-only read skips it.
  const prefetched = read.cacheOnly
    ? new Map<ObjectLinkType, ReadonlyMap<string, ObjectLinkPrefetchOutcome>>()
    : await prefetchLinks(viewer, links);
  const results = await mapBounded(links, async ({ linkType, parsed, url }) => {
    // A link type that cannot read only its cache shows only a kept card.
    const reads = !read.cacheOnly || linkType.cacheOnlyReads;
    // Each viewer has their own entry: a card holds only what they see.
    const key = `${viewer.id}:${createHash("sha256").update(url).digest("hex")}`;
    const resolve = async () =>
      (
        await resolveWithLinkType(
          linkType,
          viewer,
          parsed,
          prefetched.get(linkType)?.get(parsed.href),
          read,
        )
      )?.object ?? null;
    try {
      if (!reads) {
        // Only a fresh card, which a live read kept after its access check.
        const kept = linkType.cacheCards
          ? await createCache(getStateAdapter(), "object-links").get<
              ResolvedObjectLink["object"] | null
            >(key)
          : undefined;
        return kept ? [{ object: kept, url }] : [];
      }
      if (!linkType.cacheCards) {
        const object = await resolve();
        return object ? [{ object, url }] : [];
      }
      let fetchedAt: string | undefined;
      const cache = createCache(getStateAdapter(), "object-links", {
        onStale: (storedAtMs) => {
          fetchedAt = new Date(storedAtMs).toISOString();
        },
      });
      const object = await cache.getOrLoad(key, async () => ({
        // A failed read shows the last good card.
        staleIfError: true,
        value: await resolve(),
        ttlMs: OBJECT_LINK_TTL_MS,
      }));
      if (!object) return [];
      // A stale read inside the card is older than the card's entry.
      const age = object.fetchedAt ?? fetchedAt;
      return [{ object: age ? { ...object, fetchedAt: age } : object, url }];
    } catch (error) {
      // One failed provider read must not hide the other cards.
      logException(error, "object_link.resolve.failed", {
        "app.plugin.name": linkType.owner,
      });
      return [];
    }
  });
  return results.flat();
}
