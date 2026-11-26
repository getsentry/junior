/** Plugin HTTP routes, dashboard API routes, and Slack links. */
import {
  normalizeEventIdentifier,
  eventDataSchema,
  eventInputSchema,
  type PluginRoute,
  type PluginRouteMethod,
  type PluginRouteApp,
  type Event,
  type EventData,
  type EventPublisher,
  type SlackConversationLink,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { createPluginConversationChanges } from "@/chat/plugins/conversation-changes";
import { createPluginConversationEventReader } from "@/chat/plugins/conversation-event-reader";
import { createPluginConversationEventStats } from "@/chat/plugins/conversation-event-stats";
import { basePluginContext } from "@/chat/plugins/hook-context";
import { createPluginState } from "@/chat/plugins/state";
import { createPluginUsers, resolveViewerUser } from "@/chat/plugins/viewer";
import { createPluginCodeChanges } from "@/chat/code/plugin-code-changes";
import type { IdentityDispatcher } from "@/chat/agent-dispatch/identity";
import type { ShowInboxItem } from "@/chat/inbox-items/changes";
import { createPluginInboxItems } from "@/chat/inbox-items/plugin";
import type { SendPluginTask } from "@/chat/plugins/task-runner";
import { createPluginTaskStarter } from "@/chat/plugins/task-start";
import { apiRoutePrefix } from "@/chat/plugins/core-registrations";
import { getPlugins, getRegistrations } from "./registry";

export interface PluginRouteRegistration extends PluginRoute {
  pluginName: string;
}

export interface PluginApiRouteRegistration {
  app: PluginRouteApp;
  pluginName: string;
  /** Path where the dashboard mounts the app. */
  prefix: string;
}

const PLUGIN_ROUTE_METHODS = new Set<PluginRouteMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
]);

/** Normalize route methods so JS plugins cannot register invalid verbs. */
function routeMethods(
  route: PluginRoute,
  pluginName: string,
): PluginRouteMethod[] {
  const methods = Array.isArray(route.method)
    ? route.method
    : [route.method ?? "ALL"];
  if (methods.length === 0) {
    throw new Error(
      `Plugin route "${route.path}" from plugin "${pluginName}" must declare at least one method`,
    );
  }

  for (const method of methods) {
    if (!PLUGIN_ROUTE_METHODS.has(method)) {
      throw new Error(
        `Plugin route "${route.path}" from plugin "${pluginName}" has invalid method "${String(method)}"`,
      );
    }
  }
  if (methods.includes("ALL") && methods.length > 1) {
    throw new Error(
      `Plugin route "${route.path}" from plugin "${pluginName}" must not combine ALL with explicit methods`,
    );
  }
  return methods;
}

function requirePublishedEvent(
  plugin: PluginRegistration,
  eventType: string,
): void {
  const registration = plugin.events;
  if (!registration || registration.isEnabled?.() === false) {
    throw new Error(
      `Plugin "${plugin.manifest.name}" cannot publish events without an active registration`,
    );
  }
  if (
    !registration.resourceTypes.some((resourceType) =>
      resourceType.supportedEvents.includes(eventType),
    )
  ) {
    throw new Error(
      `Plugin "${plugin.manifest.name}" did not register event "${eventType}"`,
    );
  }
}

/** The core event publisher that plugin event publishers write to. */
export interface AppEventPublisher {
  hasMatch?(events: Event[]): Promise<boolean>;
  neededMatchKeys?(input: {
    data?: EventData;
    eventTypes: string[];
    identifiers: string[];
    namespace: string;
  }): Promise<string[]>;
  publish(event: Event): Promise<void>;
}

/**
 * Bind the core event publisher to one plugin. Events get the plugin's
 * namespace, and the plugin can publish only the event types it registered.
 */
export function createPluginEventPublisher(
  plugin: PluginRegistration,
  appEvents: AppEventPublisher,
): EventPublisher {
  const pluginName = plugin.manifest.name;
  return {
    async hasMatch(events) {
      if (!appEvents.hasMatch) return false;
      return await appEvents.hasMatch(
        events.map((event) => {
          const parsed = eventInputSchema.parse(event);
          requirePublishedEvent(plugin, parsed.eventType);
          return {
            ...parsed,
            identifier: normalizeEventIdentifier(
              plugin.events,
              parsed.identifier,
            ),
            namespace: pluginName,
          };
        }),
      );
    },
    async neededMatchKeys(input) {
      if (!appEvents.neededMatchKeys) return [];
      const identifiers = [
        ...new Set(
          input.identifiers
            .map((identifier) =>
              normalizeEventIdentifier(plugin.events, identifier),
            )
            .filter(Boolean),
        ),
      ];
      if (identifiers.length === 0 || input.eventTypes.length === 0) {
        return [];
      }
      return await appEvents.neededMatchKeys({
        ...(input.data
          ? { data: eventDataSchema.parse(input.data) }
          : undefined),
        eventTypes: input.eventTypes,
        identifiers,
        namespace: pluginName,
      });
    },
    async publish(event) {
      const parsed = eventInputSchema.parse(event);
      requirePublishedEvent(plugin, parsed.eventType);
      await appEvents.publish({
        ...parsed,
        identifier: normalizeEventIdentifier(plugin.events, parsed.identifier),
        namespace: pluginName,
      });
    },
  };
}

/** Collect route handlers exposed by plugins for app-level mounting. */
export function getPluginRoutes(options: {
  dispatchForIdentity: IdentityDispatcher;
  /** Shows an Inbox item that a plugin route changed. App setup supplies it. */
  showInboxItem?: ShowInboxItem;
  events: AppEventPublisher;
  /** Sends the tasks that routes start. */
  sendPluginTask: SendPluginTask;
}): PluginRouteRegistration[] {
  const routes: PluginRouteRegistration[] = [];
  const seen = new Set<string>();
  const methodsByPath = new Map<string, Set<PluginRouteMethod>>();

  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.routes;
    if (!hook) {
      continue;
    }
    const pluginRoutes = hook({
      ...basePluginContext(plugin),
      agent: {
        dispatchForIdentity: (dispatchOptions) =>
          options.dispatchForIdentity(pluginName, dispatchOptions),
      },
      annotations: {
        forConversation: (conversationId) =>
          createPluginAnnotations({
            conversationId,
            db: getDb(),
            plugin: pluginName,
          }),
      },
      codeChanges: createPluginCodeChanges(pluginName),
      conversationChanges: createPluginConversationChanges({
        plugin: pluginName,
        show: options.showInboxItem ?? (async () => {}),
      }),
      state: createPluginState(pluginName),
      inboxItems: {
        forConversation: (conversationId) =>
          createPluginInboxItems({
            conversationId,
            plugin: pluginName,
            show: options.showInboxItem ?? (async () => {}),
          }),
      },
      tasks: createPluginTaskStarter({
        plugin: pluginName,
        send: options.sendPluginTask,
        tasks: plugin.tasks,
      }),
      users: createPluginUsers(pluginName),
      events: createPluginEventPublisher(plugin, options.events),
    });
    if (!Array.isArray(pluginRoutes)) {
      throw new Error(
        `Plugin routes hook from plugin "${pluginName}" must return an array`,
      );
    }
    for (const route of pluginRoutes) {
      if (typeof route !== "object" || route === null || Array.isArray(route)) {
        throw new Error(
          `Plugin route from plugin "${pluginName}" must be an object`,
        );
      }
      if (typeof route.path !== "string" || !route.path.startsWith("/")) {
        throw new Error(
          `Plugin route "${route.path}" from plugin "${pluginName}" must start with /`,
        );
      }
      if (typeof route.handler !== "function") {
        throw new Error(
          `Plugin route "${route.path}" from plugin "${pluginName}" must provide a handler`,
        );
      }
      const methods = routeMethods(route, pluginName);
      const pathMethods = methodsByPath.get(route.path) ?? new Set();
      if (
        pathMethods.has("ALL") ||
        (methods.includes("ALL") && pathMethods.size > 0)
      ) {
        throw new Error(
          `Plugin route "${route.path}" conflicts with an ALL route for the same path`,
        );
      }
      for (const method of methods) {
        const key = `${method}:${route.path}`;
        if (seen.has(key)) {
          throw new Error(`Duplicate plugin route "${method} ${route.path}"`);
        }
        seen.add(key);
        pathMethods.add(method);
      }
      methodsByPath.set(route.path, pathMethods);
      routes.push({
        ...route,
        pluginName,
      });
    }
  }

  return routes;
}

/** Collect authenticated product API route apps of plugins and core features. */
export function getPluginApiRoutes(): PluginApiRouteRegistration[] {
  const routes: PluginApiRouteRegistration[] = [];

  for (const plugin of getRegistrations()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.apiRoutes;
    if (!hook) {
      continue;
    }
    const app = hook({
      ...basePluginContext(plugin),
      conversationEvents: createPluginConversationEventReader(plugin),
      eventStats: createPluginConversationEventStats(plugin),
      users: { resolve: resolveViewerUser },
    });
    if (app === undefined) {
      continue;
    }
    if (
      typeof app !== "object" ||
      app === null ||
      Array.isArray(app) ||
      typeof app.fetch !== "function"
    ) {
      throw new Error(
        `Plugin apiRoutes hook from plugin "${pluginName}" must return a fetch-compatible app`,
      );
    }
    routes.push({ app, pluginName, prefix: apiRoutePrefix(pluginName) });
  }

  return routes;
}

/** Return only absolute HTTP(S) URLs that Slack can render as footer links. */
function trustedSlackConversationUrl(
  pluginName: string,
  link: SlackConversationLink | undefined,
): string | undefined {
  const url = typeof link?.url === "string" ? link.url.trim() : "";
  if (!url) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(
      `Plugin "${pluginName}" slackConversationLink must return an absolute http(s) URL`,
      { cause: error },
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Plugin "${pluginName}" slackConversationLink must return an absolute http(s) URL`,
    );
  }
  return parsed.toString();
}

/** Resolve the first plugin conversation URL for finalized Slack footers. */
export function getPluginSlackConversationLink(
  conversationId: string,
): SlackConversationLink | undefined {
  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.slackConversationLink;
    if (!hook) {
      continue;
    }
    const link = hook({
      ...basePluginContext(plugin),
      conversationId,
    });
    const url = trustedSlackConversationUrl(pluginName, link);
    if (url) {
      return { url };
    }
  }
  return undefined;
}
