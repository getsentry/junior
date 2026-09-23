import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { briefsFeature } from "@/chat/briefs/task";
import { createMemoryFeature, type MemoryOptions } from "@/chat/memory/feature";

export interface CoreFeatureOptions {
  /** Generate a durable Brief after each completed Turn. Disabled by default. */
  briefs?: { enabled?: boolean };
  /** Long-term Memory recall, extraction, tools, and views. Enabled by default. */
  memory?: MemoryOptions;
}

/**
 * Build the core feature registrations for one app or CLI process.
 *
 * Every core feature is always present so stored events keep rendering. Each
 * feature's options decide which runtime contributions it makes.
 */
export function createCoreFeatures(
  options: CoreFeatureOptions = {},
): PluginRegistration[] {
  return [briefsFeature(options.briefs), createMemoryFeature(options.memory)];
}
