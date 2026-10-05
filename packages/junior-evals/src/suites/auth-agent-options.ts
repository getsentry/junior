/**
 * The default `createApp()` options of the auth suite. Each test in the suite
 * runs on an agent with these options. `auth.ts` also adds the skills that
 * use the plugins with `SKILL_DIRS`.
 *
 * The eval egress process registers the same plugins, because it adds the
 * credential to the requests that the sandbox sends to `example.com`.
 */
import { defineJuniorPlugins, type JuniorAppOptions } from "@sentry/junior";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";

/** A plugin whose MCP server needs OAuth. The MCP mock is the provider. */
const evalAuthPlugin = defineJuniorPlugin({
  manifest: {
    name: "eval-auth",
    displayName: "Eval Auth",
    description: "Eval-only MCP auth resume fixture",
    mcp: {
      transport: "http",
      url: "https://eval-auth.example.test/mcp",
      allowedTools: ["budget-echo"],
    },
  },
});

/** A plugin whose HTTP API needs an OAuth bearer token. */
const evalOAuthPlugin = defineJuniorPlugin({
  manifest: {
    name: "eval-oauth",
    displayName: "Eval OAuth",
    description: "Eval-only generic OAuth auth-resume fixture",
    credentials: {
      type: "oauth-bearer",
      domains: ["example.com"],
      authTokenEnv: "EVAL_OAUTH_ACCESS_TOKEN",
    },
    oauth: {
      clientIdEnv: "EVAL_OAUTH_CLIENT_ID",
      clientSecretEnv: "EVAL_OAUTH_CLIENT_SECRET",
      authorizeEndpoint:
        "https://example.com/junior-eval-oauth/oauth/authorize",
      tokenEndpoint: "https://example.com/junior-eval-oauth/oauth/token",
      scope: "read",
    },
  },
});

/** The plugins of the auth suite. */
export const authSuitePlugins = [evalAuthPlugin, evalOAuthPlugin];

export default {
  plugins: defineJuniorPlugins(authSuitePlugins),
} satisfies JuniorAppOptions;
