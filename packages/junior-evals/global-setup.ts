import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readEvalOAuthRefreshTokens,
  resetEvalOAuthMockState,
} from "@junior-tests/msw/handlers/eval-oauth";
import { mswServer } from "@junior-tests/msw/server";
import {
  interceptTestHttp,
  readTestEvalOAuthIdentityRequests,
  resetTestEvalOAuthHttpFixtures,
  resetTestGitHubHttpFixtures,
} from "@sentry/junior-testing/http";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { warmSandboxSnapshot } from "./src/snapshot-warmup";
import setupPostgres from "./postgres-global-setup";
import { startEvalEgress } from "./src/eval-egress";
import type { EvalInvocationContext } from "./src/eval-context";
import {
  evalGitHubEnv,
  evalRuntimePlugins,
  loadEvalPluginFixtures,
} from "./src/eval-plugin-fixtures";
import {
  defineJuniorPlugins,
  pluginCatalogConfigFromPluginSet,
} from "@/plugins";
import { installEvalAiGatewayDispatcher } from "./src/eval-ai-gateway-dispatcher";

type EvalGlobalProject = Parameters<typeof setupPostgres>[0] & {
  provide(key: "juniorEvalContext", value: EvalInvocationContext): void;
};

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Set up shared Postgres and public sandbox egress for one eval invocation. */
export default async function setup(
  project: EvalGlobalProject,
): Promise<() => Promise<void>> {
  const teardownPostgres = await setupPostgres(project);
  const restoreAiGatewayDispatcher = installEvalAiGatewayDispatcher();
  let previousCatalogConfig: ReturnType<typeof pluginCatalogRuntime.setConfig>;
  let egress: Awaited<ReturnType<typeof startEvalEgress>> | undefined;
  let mswListening = false;
  let previousPlugins: ReturnType<typeof setPlugins> | undefined;
  const fixtureEnv = {
    ...evalGitHubEnv(),
    SENTRY_CLIENT_ID: "eval-sentry-client-id",
    SENTRY_CLIENT_SECRET: "eval-sentry-client-secret",
    EVAL_OAUTH_CLIENT_ID: "eval-oauth-client-id",
    EVAL_OAUTH_CLIENT_SECRET: "eval-oauth-client-secret",
  };
  const previousEnv = new Map(
    [...Object.keys(fixtureEnv), "JUNIOR_BASE_URL"].map((key) => [
      key,
      process.env[key],
    ]),
  );

  /** Release every invocation-wide resource while preserving all cleanup errors. */
  const cleanup = async () => {
    const errors: unknown[] = [];
    for (const task of [
      async () => await egress?.close(),
      async () => {
        if (mswListening) mswServer.close();
      },
      async () => await disconnectStateAdapter(),
      async () => {
        pluginCatalogRuntime.setConfig(previousCatalogConfig);
        if (previousPlugins) setPlugins(previousPlugins);
        for (const [key, value] of previousEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      },
      teardownPostgres,
      restoreAiGatewayDispatcher,
    ]) {
      try {
        await task();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Eval global cleanup failed");
    }
  };

  try {
    const redisUrl = process.env.REDIS_URL?.trim();
    const stateKeyPrefix = process.env.JUNIOR_STATE_KEY_PREFIX?.trim();
    if (!redisUrl || !stateKeyPrefix) {
      throw new Error(
        "Eval global setup requires REDIS_URL and JUNIOR_STATE_KEY_PREFIX",
      );
    }
    const pluginFixtures = loadEvalPluginFixtures([
      path.resolve(workspaceRoot, "packages/junior-evals/fixtures/plugins"),
    ]);
    const packages = ["@sentry/junior-github", "@sentry/junior-sentry"];
    const runtimePlugins = evalRuntimePlugins(packages);
    const pluginConfig = pluginCatalogConfigFromPluginSet(
      defineJuniorPlugins([...packages, ...runtimePlugins]),
    );
    previousPlugins = setPlugins(runtimePlugins);
    Object.assign(process.env, fixtureEnv);
    previousCatalogConfig = pluginCatalogRuntime.setConfig({
      ...pluginConfig,
      inlineManifests: [
        ...pluginFixtures,
        ...(pluginConfig?.inlineManifests ?? []),
      ],
    });
    mswServer.listen({ onUnhandledRequest: "bypass" });
    mswListening = true;
    egress = await startEvalEgress({
      interceptHttp: interceptTestHttp,
      readFixtureState: () => ({
        evalOAuthIdentityRequests: readTestEvalOAuthIdentityRequests(),
        evalOAuthRefreshTokens: readEvalOAuthRefreshTokens(),
      }),
      resetFixtures: () => {
        resetEvalOAuthMockState();
        resetTestEvalOAuthHttpFixtures();
        resetTestGitHubHttpFixtures();
      },
    });
    process.env.JUNIOR_BASE_URL = egress.baseUrl;
    for (const packages of [
      [],
      ["@sentry/junior-github"],
      ["@sentry/junior-sentry"],
    ]) {
      await warmSandboxSnapshot(packages);
    }
    project.provide("juniorEvalContext", {
      baseUrl: egress.baseUrl,
      controlToken: egress.controlToken,
      controlUrl: egress.controlUrl,
      redisUrl,
      stateKeyPrefix,
      stateUrl: egress.stateUrl,
    });
    process.stdout.write(`[evals] Public egress ready at ${egress.baseUrl}\n`);
    return cleanup;
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Eval global setup and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}
