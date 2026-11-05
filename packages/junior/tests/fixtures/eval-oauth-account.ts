import {
  defineJuniorPlugin,
  type PluginHooks,
  type PluginProviderAccount,
} from "@sentry/junior-plugin-api";

/**
 * Register the eval OAuth provider with a `resolveOAuthAccount` hook through
 * the public app API. Its endpoints match the shared eval-oauth MSW handlers.
 * Pass `name` to register the same provider under another plugin name, and
 * `options` to enable the dashboard or add an `identityLinked` hook.
 */
export async function createEvalOAuthAccountApp(
  account: PluginProviderAccount,
  name = "eval-oauth",
  options: {
    dashboard?: boolean;
    identityLinked?: PluginHooks["identityLinked"];
  } = {},
): Promise<void> {
  const { createApp, defineJuniorPlugins } = await import("@/app");
  await createApp({
    ...(options.dashboard ? { dashboard: { authRequired: false } } : undefined),
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name,
          displayName: "Eval OAuth",
          description: "Eval OAuth fixture",
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
        hooks: {
          resolveOAuthAccount: () => account,
          ...(options.identityLinked
            ? { identityLinked: options.identityLinked }
            : undefined),
        },
      }),
    ]),
  });
}
