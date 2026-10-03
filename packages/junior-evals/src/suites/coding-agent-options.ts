/**
 * The default `createApp()` options of the coding suite. Each test in the
 * suite runs on an agent with these options. `coding.ts` also adds the coding
 * skills with `SKILL_DIRS`.
 */
import { defineJuniorPlugins, type JuniorAppOptions } from "@sentry/junior";
import { githubPlugin } from "@sentry/junior-github";
import { memoryPlugin } from "@sentry/junior-memory";

export default {
  plugins: defineJuniorPlugins([githubPlugin(), memoryPlugin()]),
} satisfies JuniorAppOptions;
