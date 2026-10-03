/**
 * The default `createApp()` options of the coding suite. Each test in
 * `evals/integration/coding/` runs on an agent with these options. The suite
 * config also adds the coding skills with `SKILL_DIRS`.
 */
import { defineJuniorPlugins, type JuniorAppOptions } from "@sentry/junior";
import { githubPlugin } from "@sentry/junior-github";
import { memoryPlugin } from "@sentry/junior-memory";

export default {
  plugins: defineJuniorPlugins([githubPlugin(), memoryPlugin()]),
} satisfies JuniorAppOptions;
