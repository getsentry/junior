import { defineJuniorPlugins } from "@sentry/junior";
import { juniorDashboardPlugin } from "@sentry/junior-dashboard";
import { githubPlugin } from "@sentry/junior-github";
import {
  exampleDashboardAuthRequired,
  exampleDashboardMockConversations,
} from "./dashboard.ts";

process.env.GITHUB_APP_BOT_NAME ||= "sentry-junior[bot]";
process.env.GITHUB_APP_BOT_EMAIL ||=
  "264270552+sentry-junior[bot]@users.noreply.github.com";

export const plugins = defineJuniorPlugins([
  juniorDashboardPlugin({
    authRequired: exampleDashboardAuthRequired(),
    allowedGoogleDomains: ["sentry.io"],
    mockConversations: exampleDashboardMockConversations(),
  }),
  "@sentry/junior-agent-browser",
  "@sentry/junior-datadog",
  githubPlugin({
    botNameEnv: "GITHUB_APP_BOT_NAME",
    botEmailEnv: "GITHUB_APP_BOT_EMAIL",
  }),
  "@sentry/junior-hex",
  "@sentry/junior-linear",
  "@sentry/junior-notion",
  "@sentry/junior-sentry",
  "@sentry/junior-vercel",
]);
