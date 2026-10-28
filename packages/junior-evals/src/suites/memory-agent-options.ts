/**
 * The default `createApp()` options of the memory suite. Each test in the
 * suite runs on an agent with these options.
 */
import { defineJuniorPlugins, type JuniorAppOptions } from "@sentry/junior";
import { memoryPlugin } from "@sentry/junior-memory";

export default {
  plugins: defineJuniorPlugins([memoryPlugin()]),
} satisfies JuniorAppOptions;
