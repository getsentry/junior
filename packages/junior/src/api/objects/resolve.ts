import { mapBounded } from "@/chat/fan-out";
import { createHash } from "node:crypto";
import {
  objectAnnotationSchema,
  ownedObjectAnnotationSchema,
  type ObjectLinkContext,
  type ObjectLinkPrefetchOutcome,
  type ObjectType,
  type OwnedObjectAnnotation,
  type PluginRegistration,
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
import { createPluginCache } from "@/chat/plugins/cache";
import { createPluginLogger } from "@/chat/plugins/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { createCache } from "@/chat/state/cache";
import {
  canViewConversationLink,
  resolveConversationLink,
} from "./conversation";
import {
  assertNoObjectLinkConflicts,
  findObjectLinkType,
  linkTypeName,
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

// Links resolve outside a Turn, so no person is the credential subject. This
// system Actor gets only credentials that a plugin owns, never the viewer's.
// Each plugin checks that the viewer may see an object before it returns it.
const OBJECT_LINK_SYSTEM_ACTOR = {
  platform: "system",
  name: "object-link",
} as const;

function coreLinkTypes(): ObjectLinkType[] {
  // Slack runtime is in core until Slack is a plugin.
  const slack: ObjectLinkType = {
    // The card read checks channel access inside the viewer's Slack
    // workspace, so it shares one Slack installation with the check.
    canView: async () => true,
    filters: [SLACK_MESSAGE_LINK_FILTER],
    objectTypes: ["message"],
    owner: "junior",
    resolve: resolveSlackMessageLink,
  };
  const conversations = getDashboardLinkFilter("/conversations/*");
  const people = getDashboardLinkFilter("/people/*");
  // Any other public page. Its filters are the least specific.
  const webPages = webPageLinkType();
  // These links need the dashboard: each card links to a dashboard page.
  if (!conversations || !people) return [slack, webPages];
  return [
    slack,
    webPages,
    {
      canView: canViewConversationLink,
      filters: [conversations],
      objectTypes: ["conversation"],
      owner: "junior",
      resolve: resolveConversationLink,
    },
    {
      // Person cards read the identity cache. A link or unlink clears it.
      cacheCards: false,
      // Every signed-in viewer sees the People pages.
      canView: async () => true,
      filters: [people, { scheme: "mailto" }],
      objectTypes: ["person"],
      owner: "junior",
      resolve: (_viewer, url) => resolvePersonLink(url),
    },
  ];
}

function objectLinkContext(
  name: string,
  viewer: User,
  prefetched?: ObjectLinkPrefetchOutcome,
): ObjectLinkContext {
  return {
    ...(prefetched ? { prefetchOutcome: prefetched } : undefined),
    cache: createPluginCache(name),
    db: getDb(),
    egress: createPluginEgress({
      credentialContext: credentialContextForActor(OBJECT_LINK_SYSTEM_ACTOR),
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
      pluginAuth: { async handleAuthRequired() {} },
      userOAuthOnly: true,
    }),
    viewerMcp: createViewerMcp(name, viewer.id),
  };
}

function pluginLinkTypes(plugin: PluginRegistration): ObjectLinkType[] {
  const name = plugin.manifest.name;
  return (plugin.objectLinks ?? []).map((link) => ({
    ...(link.cacheCards === false ? { cacheCards: false } : undefined),
    canView: (viewer, url, prefetched) =>
      link.canView(objectLinkContext(name, viewer, prefetched), url),
    filters: link.filters,
    objectTypes: link.objectTypes,
    owner: name,
    ...(link.prefetch
      ? {
          prefetch: async (viewer: User, urls: URL[]) =>
            await link.prefetch?.(objectLinkContext(name, viewer), urls),
        }
      : undefined),
    resolve: (viewer, url, prefetched) =>
      link.resolve(objectLinkContext(name, viewer, prefetched), url),
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
): Promise<ResolvedObjectLink | null> {
  if (!(await linkType.canView(viewer, url, prefetched))) {
    // The web page card reads only what anyone can read signed out.
    return linkType.webPageFallback
      ? await resolveWithLinkType(webPageLinkType(), viewer, url)
      : null;
  }
  const resolved = await linkType.resolve(viewer, url, prefetched);
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
      plugin: linkType.owner,
    }),
  };
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
  return (
    linkType?.owner === plugin &&
    (await linkType.canView(viewer, url)) &&
    Boolean(await linkType.resolve(viewer, url))
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
 * Conversation.
 */
export async function resolveObjectLinks(
  viewer: User,
  urls: readonly string[],
): Promise<Array<{ object: OwnedObjectAnnotation; url: string }>> {
  const linkTypes = readObjectLinkTypes();
  const cache = createCache(getStateAdapter(), "object-links");
  const links = [...new Set(urls)].flatMap((url) => {
    const parsed = URL.canParse(url) ? new URL(url) : undefined;
    const linkType = parsed && findObjectLinkType(linkTypes, parsed);
    return parsed && linkType ? [{ linkType, parsed, url }] : [];
  });
  const prefetched = await prefetchLinks(viewer, links);
  const results = await mapBounded(links, async ({ linkType, parsed, url }) => {
    // Each viewer has their own entry: a card holds only what they see.
    const key = `${viewer.id}:${createHash("sha256").update(url).digest("hex")}`;
    const resolve = async () =>
      (
        await resolveWithLinkType(
          linkType,
          viewer,
          parsed,
          prefetched.get(linkType)?.get(parsed.href),
        )
      )?.object ?? null;
    try {
      const object =
        linkType.cacheCards === false
          ? await resolve()
          : await cache.getOrLoad(key, async () => ({
              value: await resolve(),
              ttlMs: OBJECT_LINK_TTL_MS,
            }));
      return object ? [{ object, url }] : [];
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
