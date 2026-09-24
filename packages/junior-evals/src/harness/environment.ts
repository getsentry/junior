/**
 * Per-scenario environment: env vars, plugin catalog, state, and credential seeding.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type PluginRegistration } from "@sentry/junior-plugin-api";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import {
  defineJuniorPlugins,
  pluginCatalogConfigFromPluginSet,
} from "@/plugins";
import { getStateAdapter } from "@/chat/state/adapter";
import { resetSkillDiscoveryCache } from "@/chat/skills";
import { TEST_USER_ID } from "@junior-tests/fixtures/slack/factories/ids";
import { loadEvalPluginFixtures } from "../eval-plugin-fixtures";
import { scenarioEvents, type EvalScenario } from "./types";
import { cleanupHarnessThreadState } from "./threads";
import {
  cleanupMcpAuthState,
  cleanupOAuthTokens,
  configureCredentialProviderEnv,
  seedCredentialProviderTokens,
  seedExpiredOAuthTokens,
} from "./auth-fixtures";

const EVAL_PACKAGE_ROOT = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
export type HarnessStateAdapter = ReturnType<typeof getStateAdapter>;

/** Resolve a scenario path against the junior-evals package root. */
export function resolveEvalRelativePath(entry: string): string {
  return path.isAbsolute(entry)
    ? entry
    : path.resolve(EVAL_PACKAGE_ROOT, entry);
}

const HARNESS_ENV_KEYS = [
  "GITHUB_APP_BOT_EMAIL",
  "GITHUB_APP_BOT_NAME",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_INSTALLATION_ID",
  "GITHUB_WEBHOOK_SECRET",
  "JUNIOR_BASE_URL",
  "JUNIOR_SECRET",
  "JUNIOR_STATE_ADAPTER",
  "SENTRY_CLIENT_ID",
  "SENTRY_CLIENT_SECRET",
  "SLACK_BOT_TOKEN",
] as const;
const DEFAULT_EVAL_BASE_URL = "https://junior.example.com";

interface EnvSnapshot {
  restore(): void;
}

function snapshotEnv(keys: readonly string[]): EnvSnapshot {
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
  }
  return {
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

function ensureHarnessBaseUrl(): void {
  process.env.JUNIOR_BASE_URL ??= DEFAULT_EVAL_BASE_URL;
}

export interface HarnessEnvironment {
  authActorUsers: Set<string>;
  autoCompleteMcpOauthProviders: Set<string>;
  autoCompleteOauthProviders: Set<string>;
  credentialProviders: Set<"github" | "sentry">;
  expiredOauthProviders: Set<string>;
  configuredSkillDirs: string[];
  envSnapshot: EnvSnapshot;
  stateAdapter: HarnessStateAdapter;
}

/** Prepare env vars, plugin catalog, state, and credentials for one scenario. */
export async function setupHarnessEnvironment(
  scenario: EvalScenario,
  runtimePlugins: PluginRegistration[],
): Promise<HarnessEnvironment> {
  const envSnapshot = snapshotEnv(HARNESS_ENV_KEYS);

  try {
    const configuredSkillDirs =
      scenario.overrides?.skill_dirs?.map(resolveEvalRelativePath) ?? [];
    const configuredPluginDirs =
      scenario.overrides?.plugin_dirs?.map(resolveEvalRelativePath) ?? [];
    const pluginFixtures = loadEvalPluginFixtures(configuredPluginDirs);
    const autoCompleteMcpOauthProviders = new Set(
      scenario.overrides?.auto_complete_mcp_oauth?.map((p) => p.trim()) ?? [],
    );
    const autoCompleteOauthProviders = new Set(
      scenario.overrides?.auto_complete_oauth?.map((p) => p.trim()) ?? [],
    );
    const credentialProviders = new Set(
      scenario.overrides?.credential_providers ?? [],
    );
    const expiredOauthProviders = new Set(
      scenario.overrides?.expired_oauth_tokens?.map((provider) =>
        provider.trim(),
      ) ?? [],
    );
    const authActorUsers = new Set(
      scenarioEvents(scenario).flatMap((event) =>
        "message" in event
          ? [event.message.author?.user_id?.trim() || TEST_USER_ID]
          : "user_id" in event && event.user_id
            ? [event.user_id]
            : [],
      ),
    );
    if (authActorUsers.size === 0) {
      authActorUsers.add(TEST_USER_ID);
    }

    configureCredentialProviderEnv(credentialProviders);
    if (scenario.overrides?.github_events) {
      process.env.GITHUB_WEBHOOK_SECRET = "eval-github-webhook-secret";
    } else {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    }
    ensureHarnessBaseUrl();
    process.env.JUNIOR_SECRET = "junior-test-secret";
    const pluginConfig = pluginCatalogConfigFromPluginSet(
      defineJuniorPlugins([
        ...(scenario.overrides?.plugin_packages ?? []),
        ...runtimePlugins,
      ]),
    );
    pluginCatalogRuntime.setConfig({
      inlineManifests: [
        ...pluginFixtures,
        ...(pluginConfig?.inlineManifests ?? []),
      ],
      packages: pluginConfig?.packages ?? [],
    });

    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    resetSkillDiscoveryCache();
    await cleanupHarnessThreadState(stateAdapter, scenario);
    await cleanupMcpAuthState(authActorUsers, autoCompleteMcpOauthProviders);
    await cleanupOAuthTokens(authActorUsers, autoCompleteOauthProviders);
    await cleanupOAuthTokens(authActorUsers, credentialProviders);
    await cleanupOAuthTokens(authActorUsers, expiredOauthProviders);
    await seedCredentialProviderTokens({
      providers: credentialProviders,
      userIds: authActorUsers,
    });
    await seedExpiredOAuthTokens({
      providers: expiredOauthProviders,
      userIds: authActorUsers,
    });

    return {
      authActorUsers,
      autoCompleteMcpOauthProviders,
      autoCompleteOauthProviders,
      credentialProviders,
      expiredOauthProviders,
      configuredSkillDirs,
      envSnapshot,
      stateAdapter,
    };
  } catch (error) {
    resetSkillDiscoveryCache();
    pluginCatalogRuntime.setConfig(undefined);
    envSnapshot.restore();
    throw error;
  }
}

/** Release scenario state and restore the process environment. */
export async function teardownHarnessEnvironment(
  scenario: EvalScenario,
  env: HarnessEnvironment,
): Promise<void> {
  resetSkillDiscoveryCache();
  pluginCatalogRuntime.setConfig(undefined);
  try {
    await cleanupHarnessThreadState(env.stateAdapter, scenario);
    await cleanupMcpAuthState(
      env.authActorUsers,
      env.autoCompleteMcpOauthProviders,
    );
    await cleanupOAuthTokens(
      env.authActorUsers,
      env.autoCompleteOauthProviders,
    );
    await cleanupOAuthTokens(env.authActorUsers, env.credentialProviders);
    await cleanupOAuthTokens(env.authActorUsers, env.expiredOauthProviders);
  } finally {
    env.envSnapshot.restore();
  }
}
