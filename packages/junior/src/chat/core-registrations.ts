import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { isBriefsEnabled } from "@/chat/briefs/registration";
import { briefsTaskRegistration } from "@/chat/briefs/task";
import {
  isSpacesEnabled,
  spacesRegistration,
} from "@/chat/spaces/registration";

/**
 * Core features that use the plugin registration contract but are not
 * installed plugins. Spaces classify from Briefs, so they need Briefs.
 */
export function coreRegistrations(): PluginRegistration[] {
  if (!isBriefsEnabled()) return [];
  return isSpacesEnabled()
    ? [briefsTaskRegistration, spacesRegistration]
    : [briefsTaskRegistration];
}

/** Every core registration whose stored events may need rendering. */
export function coreEventRegistrations(): PluginRegistration[] {
  return [briefsTaskRegistration, spacesRegistration];
}
