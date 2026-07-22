import { defineJuniorPlugins } from "@sentry/junior";
import { githubPlugin } from "@sentry/junior-github";
import { createMemoryPlugin } from "@sentry/junior-memory";
import { schedulerPlugin } from "@sentry/junior-scheduler";

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
  "@sentry/junior-linear",
  createMemoryPlugin(),
  "@sentry/junior-notion",
  schedulerPlugin(),
  "@sentry/junior-sentry",
  "@sentry/junior-vercel",
]);
