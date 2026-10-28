import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { briefsTaskRegistration } from "./task";

type BriefsConfig = Readonly<{ enabled?: boolean }>;

let configuredBriefs: BriefsConfig = {};

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

/** Return enabled core task registrations. */
export function coreTaskRegistrations(): PluginRegistration[] {
  return isBriefsEnabled() ? [briefsTaskRegistration] : [];
}
