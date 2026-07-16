import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readEvalOAuthRefreshTokens,
  resetEvalOAuthMockState,
} from "@junior-tests/msw/handlers/eval-oauth";
import { mswServer } from "@junior-tests/msw/server";
import {
  interceptTestHttp,
  resetTestGitHubHttpFixtures,
} from "@sentry/junior-testing/http";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import setupPostgres from "./postgres-global-setup";
import { startEvalEgress } from "./src/eval-egress";
import type { EvalEgressContext } from "./src/eval-context";
import { loadEvalPluginFixtures } from "./src/eval-plugin-fixtures";

type EvalGlobalProject = Parameters<typeof setupPostgres>[0] & {
  provide(key: "juniorEvalEgress", value: EvalEgressContext): void;
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
  let previousCatalogConfig: ReturnType<typeof pluginCatalogRuntime.setConfig>;
  let egress: Awaited<ReturnType<typeof startEvalEgress>> | undefined;
  let mswListening = false;

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
      },
      teardownPostgres,
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
    const pluginFixtures = loadEvalPluginFixtures([
      path.resolve(workspaceRoot, "packages/junior-evals/fixtures/plugins"),
    ]);
    previousCatalogConfig = pluginCatalogRuntime.setConfig({
      inlineManifests: pluginFixtures.inlineManifests,
      packages: ["@sentry/junior-sentry"],
    });
    process.env.EVAL_OAUTH_CLIENT_ID = "eval-oauth-client-id";
    process.env.EVAL_OAUTH_CLIENT_SECRET = "eval-oauth-client-secret";
    mswServer.listen({ onUnhandledRequest: "bypass" });
    mswListening = true;
    egress = await startEvalEgress({
      interceptHttp: interceptTestHttp,
      readFixtureState: () => ({
        evalOAuthRefreshTokens: readEvalOAuthRefreshTokens(),
      }),
      resetFixtures: () => {
        resetEvalOAuthMockState();
        resetTestGitHubHttpFixtures();
      },
    });
    project.provide("juniorEvalEgress", {
      baseUrl: egress.baseUrl,
      controlToken: egress.controlToken,
      controlUrl: egress.controlUrl,
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
