import { defineJuniorPlugins } from "@sentry/junior";
import { juniorDashboardPlugin } from "@sentry/junior-dashboard";
import { githubPlugin } from "@sentry/junior-github";
import { exampleDashboardAuthRequired } from "./dashboard.ts";

export const plugins = defineJuniorPlugins([
  juniorDashboardPlugin({
    authRequired: exampleDashboardAuthRequired(),
    allowedGoogleDomains: ["sentry.io"],
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
