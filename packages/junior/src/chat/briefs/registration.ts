import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { notificationsTaskRegistration } from "@/chat/notifications/task";
import { readWebPushConfig } from "@/chat/notifications/web-push";
import { eventSearchTaskRegistration } from "@/chat/conversations/event-embedding";
import { briefsTaskRegistration } from "./task";

type BriefsConfig = Readonly<{ enabled?: boolean }>;
type EventEmbeddingsConfig = Readonly<{ enabled?: boolean }>;

let configuredBriefs: BriefsConfig = {};
let configuredEventEmbeddings: EventEmbeddingsConfig = {};

/** Replace app-level Brief settings and return the previous setting. */
export function setBriefsConfig(config?: { enabled?: boolean }): BriefsConfig {
  const previous = { ...configuredBriefs };
  configuredBriefs = config ? { ...config } : {};
  return previous;
}

/** Return whether automatic Brief generation is enabled. */
export function isBriefsEnabled(): boolean {
  return configuredBriefs.enabled === true;
}

/** Replace app-level event embedding settings and return the previous setting. */
export function setEventEmbeddingsConfig(config?: {
  enabled?: boolean;
}): EventEmbeddingsConfig {
  const previous = { ...configuredEventEmbeddings };
  configuredEventEmbeddings = config ? { ...config } : {};
  return previous;
}

/** Return whether event embeddings and meaning search are enabled. */
export function isEventEmbeddingsEnabled(): boolean {
  return configuredEventEmbeddings.enabled === true;
}

/**
 * Return enabled core task registrations: Briefs, event search, and reply
 * notifications. Event search always stores lexemes, which cost no provider
 * call. It embeds events only when event embeddings are enabled.
 */
export function coreTaskRegistrations(): PluginRegistration[] {
  return [
    ...(isBriefsEnabled() ? [briefsTaskRegistration] : []),
    eventSearchTaskRegistration({ embedEvents: isEventEmbeddingsEnabled() }),
    ...(readWebPushConfig() ? [notificationsTaskRegistration] : []),
  ];
}
