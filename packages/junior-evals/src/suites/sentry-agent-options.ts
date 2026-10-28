/**
 * The default `createApp()` options of the Sentry suite. Each test in the
 * suite runs on an agent with these options.
 */
import { defineJuniorPlugins, type JuniorAppOptions } from "@sentry/junior";
import { sentryPlugin } from "@sentry/junior-sentry";

export default {
  plugins: defineJuniorPlugins([sentryPlugin()]),
} satisfies JuniorAppOptions;
