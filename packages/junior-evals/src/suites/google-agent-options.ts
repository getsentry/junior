/**
 * The default `createApp()` options of the Google suite. Each test in the
 * suite runs on an agent with these options.
 */
import { defineJuniorPlugins, type JuniorAppOptions } from "@sentry/junior";
import { googlePlugin } from "@sentry/junior-google";

export default {
  plugins: defineJuniorPlugins([googlePlugin()]),
} satisfies JuniorAppOptions;
