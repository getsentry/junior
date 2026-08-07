import { defineJuniorPlugins } from "@sentry/junior";
import { githubPlugin } from "@sentry/junior-github";
import { linearPlugin } from "@sentry/junior-linear";
import { memoryPlugin } from "@sentry/junior-memory";
import { sentryPlugin } from "@sentry/junior-sentry";
import { vercelPlugin } from "@sentry/junior-vercel";

process.env.GITHUB_APP_BOT_NAME ||= "sentry-junior[bot]";
process.env.GITHUB_APP_BOT_EMAIL ||=
  "264270552+sentry-junior[bot]@users.noreply.github.com";

export const plugins = defineJuniorPlugins([
  "@sentry/junior-agent-browser",
  "@sentry/junior-amplitude",
  "@sentry/junior-datadog",
  githubPlugin({
    botNameEnv: "GITHUB_APP_BOT_NAME",
    botEmailEnv: "GITHUB_APP_BOT_EMAIL",
  }),
  "@sentry/junior-hex",
  linearPlugin(),
  memoryPlugin(),
  "@sentry/junior-notion",
  sentryPlugin(),
  vercelPlugin(),
]);
