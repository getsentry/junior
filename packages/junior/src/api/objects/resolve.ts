import { createHash } from "node:crypto";
import {
  objectAnnotationSchema,
  ownedObjectAnnotationSchema,
  type OwnedObjectAnnotation,
  type PluginRegistration,
  type User,
} from "@sentry/junior-plugin-api";
import { getDashboardLinkFilter } from "@/chat/dashboard-link";
import { credentialContextForActor } from "@/chat/credentials/context";
import { getDb } from "@/chat/db";
import { createPluginEgress } from "@/chat/egress/plugin";
import { logException } from "@/chat/logging";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { createPluginCache } from "@/chat/plugins/cache";
import { createPluginLogger } from "@/chat/plugins/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { createCache } from "@/chat/state/cache";
import { resolveConversationLink } from "./conversation";
import {
  assertNoObjectLinkConflicts,
  findObjectLinkType,
  type ObjectLinkType,
} from "./link-types";
import { resolvePersonByAccount, resolvePersonLink } from "./person";
import {
  resolveSlackMessageLink,
  SLACK_MESSAGE_LINK_FILTER,
} from "./slack-message";

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
    filters: [SLACK_MESSAGE_LINK_FILTER],
    objectType: "message",
    owner: "junior",
    resolve: resolveSlackMessageLink,
  };
  const conversations = getDashboardLinkFilter("/conversations/*");
  const people = getDashboardLinkFilter("/people/*");
  // These links need the dashboard: each card links to a dashboard page.
  if (!conversations || !people) return [slack];
  return [
    slack,
    {
      filters: [conversations],
      objectType: "conversation",
      owner: "junior",
      resolve: resolveConversationLink,
    },
    {
      // Person cards read the identity cache. A link or unlink clears it.
      cacheCards: false,
      filters: [people, { scheme: "mailto" }],
      objectType: "person",
      owner: "junior",
      resolve: (_viewer, url) => resolvePersonLink(url),
    },
  ];
}

function pluginLinkTypes(plugin: PluginRegistration): ObjectLinkType[] {
  const name = plugin.manifest.name;
  return (plugin.objectLinks ?? []).map((link) => ({
    filters: link.filters,
    objectType: link.objectType,
    owner: name,
    resolve: (viewer, url) =>
      link.resolve(
        {
          cache: createPluginCache(name),
          db: getDb(),
          egress: createPluginEgress({
            credentialContext: credentialContextForActor(
              OBJECT_LINK_SYSTEM_ACTOR,
            ),
            // A card is optional. It must never ask anyone to authorize.
            pluginAuth: { async handleAuthRequired() {} },
          }),
          findPerson: resolvePersonByAccount,
          log: createPluginLogger(name),
          plugin: { name },
          viewer,
        },
        url,
      ),
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

async function resolveWithLinkType(
  linkType: ObjectLinkType,
  viewer: User,
  url: URL,
): Promise<OwnedObjectAnnotation | null> {
  const resolved = await linkType.resolve(viewer, url);
  if (!resolved) return null;
  const object = objectAnnotationSchema.parse(resolved);
  if (object.objectType !== linkType.objectType) {
    throw new Error(
      `Link type "${linkType.owner}/${linkType.objectType}" returned a ${object.objectType} object.`,
    );
  }
  return ownedObjectAnnotationSchema.parse({
    ...object,
    plugin: linkType.owner,
  });
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
  const results = await Promise.all(
    [...new Set(urls)].map(async (url) => {
      const parsed = URL.canParse(url) ? new URL(url) : undefined;
      const linkType = parsed && findObjectLinkType(linkTypes, parsed);
      if (!parsed || !linkType) return [];
      // Each viewer has their own entry: a card holds only what they see.
      const key = `${viewer.id}:${createHash("sha256").update(url).digest("hex")}`;
      const resolve = () => resolveWithLinkType(linkType, viewer, parsed);
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
    }),
  );
  return results.flat();
}
