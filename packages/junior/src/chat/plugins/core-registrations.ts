/**
 * Core features that use the plugin registration shape, so they reach the
 * same hook sites as app plugins. Package discovery never loads them, and an
 * app plugin cannot use their names.
 */
import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { eventSearchTaskRegistration } from "@/chat/conversations/event-embedding";
import { isEventEmbeddingsEnabled } from "@/chat/conversations/event-embedding-config";
import { memoryRegistration } from "@/chat/memory/registration";
import { notificationsTaskRegistration } from "@/chat/notifications/task";
import { readWebPushConfig } from "@/chat/notifications/web-push";
import { relatedConversationsRegistration } from "@/chat/related-conversations/registration";
import { todosRegistration } from "@/chat/todos/registration";

/** Return whether a core feature owns this registration name. */
export function isCoreRegistrationName(name: string): boolean {
  // Read the names at call time: these modules import the plugin hooks, so
  // their registrations are not ready while this module loads.
  return [
    eventSearchTaskRegistration({ embedEvents: false }),
    memoryRegistration(),
    notificationsTaskRegistration,
    relatedConversationsRegistration,
    todosRegistration,
  ].some((registration) => registration.manifest.name === name);
}

/**
 * Return where the dashboard mounts the API routes of a registration. Core
 * features own a top-level `/api` path.
 */
export function apiRoutePrefix(name: string): string {
  return isCoreRegistrationName(name) ? `/api/${name}` : `/api/plugins/${name}`;
}

/**
 * Return enabled core registrations: event search, Memory, related
 * Conversations, To-dos, and reply notifications. Event search always stores
 * lexemes, which cost no provider call. It embeds events only when event
 * embeddings are enabled.
 */
export function coreRegistrations(): PluginRegistration[] {
  return [
    eventSearchTaskRegistration({ embedEvents: isEventEmbeddingsEnabled() }),
    memoryRegistration(),
    relatedConversationsRegistration,
    todosRegistration,
    ...(readWebPushConfig() ? [notificationsTaskRegistration] : []),
  ];
}
