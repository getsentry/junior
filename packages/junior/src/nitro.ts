import path from "node:path";
import { sentryOrchestrionPlugin } from "@sentry/server-utils/orchestrion/rollup";
import type { Nitro } from "nitro/types";
import { applyRolldownTreeshakeWorkaround } from "@/build/rolldown-workarounds";
import {
  copyDashboardAssets,
  copyIncludedFiles,
  copyRuntimeContent,
} from "@/build/copy-build-content";
import {
  injectVirtualConfig,
  type RuntimePluginModule,
} from "@/build/virtual-config";
import { PLUGIN_TASK_QUEUE_TOPIC } from "@/chat/plugins/task-queue";
import { WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC } from "@/chat/sandbox/snapshot/job-queue";
import { resolveConversationWorkQueueTopic } from "@/chat/task-execution/vercel-queue";
import {
  JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE,
  JUNIOR_HEARTBEAT_CRON_SCHEDULE,
  JUNIOR_HEARTBEAT_ROUTE,
  JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE,
  JUNIOR_RETENTION_CRON_SCHEDULE,
  JUNIOR_RETENTION_ROUTE,
  JUNIOR_WORKSPACE_SNAPSHOT_JOB_CALLBACK_ROUTE,
} from "@/deployment";
import {
  pluginCatalogConfigFromPluginSet,
  pluginRuntimeRegistrationsFromPluginSet,
  type JuniorPluginSet,
} from "./plugins";
import { loadPluginSetFromModule, resolvePluginModule } from "./plugin-module";
import type { JuniorDashboardOptions } from "./app";

export type JuniorNitroDashboardOptions = JuniorDashboardOptions;

export interface JuniorPluginModuleReference {
  /** Runtime-safe module that exports a `defineJuniorPlugins(...)` set. */
  module: string;
  /** Named export to import from `module`. Defaults to `plugins`. */
  exportName?: string;
}

export type JuniorNitroPluginSource =
  | JuniorPluginModuleReference
  | JuniorPluginSet
  | string;

export interface JuniorNitroOptions {
  cwd?: string;
  /** Authenticated dashboard configuration injected for createApp(). */
  dashboard?: JuniorNitroDashboardOptions;
  maxDuration?: number;
  /** Vercel Queue topic for durable conversation work. Must match the runtime queue producer topic. */
  conversationWorkQueueTopic?: string;
  /** Plugin catalog set or runtime-safe plugin module. Direct sets must not include runtime code. */
  plugins?: JuniorNitroPluginSource;
  /**
   * Extra file patterns to copy into the server output for files that the
   * bundler cannot trace (e.g. dynamically imported providers).
   * Each entry is `"<package-name>/<subpath-glob>"`, resolved via Node
   * module resolution. Example: `"@earendil-works/pi-ai/dist/providers/*.js"`
   */
  includeFiles?: string[];
}

type RollupLikeConfig = {
  plugins?: unknown[];
};

const DEFAULT_FUNCTION_MAX_DURATION_SECONDS = 300;
const VERCEL_QUEUE_TRIGGER_TYPE = "queue/v2beta";

function isPluginModuleReference(
  value: JuniorNitroPluginSource | undefined,
): value is JuniorPluginModuleReference | string {
  return typeof value === "string" || Boolean(value && "module" in value);
}

function isPluginSet(
  value: JuniorNitroPluginSource | undefined,
): value is JuniorPluginSet {
  if (!value || typeof value !== "object") {
    return false;
  }

  return "packageNames" in value && "registrations" in value;
}

function assertSerializableDirectPluginSet(pluginSet: JuniorPluginSet): void {
  const pluginRuntimeNames = pluginRuntimeRegistrationsFromPluginSet(
    pluginSet,
  ).map((plugin) => plugin.manifest.name);
  if (pluginRuntimeNames.length === 0) {
    return;
  }

  throw new Error(
    `juniorNitro({ plugins }) cannot receive a direct defineJuniorPlugins(...) set with runtime plugin registration(s): ${pluginRuntimeNames.join(", ")}. Export the set from a runtime-safe plugin module and pass juniorNitro({ plugins: "./plugins" }) so createApp() can import the same registrations at runtime.`,
  );
}

function dashboardEnabled(
  dashboard: JuniorNitroDashboardOptions | undefined,
): boolean {
  return Boolean(dashboard && !dashboard.disabled);
}

function runtimeModuleForResolvedPluginModule(
  moduleRef: ReturnType<typeof resolvePluginModule>,
): RuntimePluginModule {
  return {
    exportName: moduleRef.exportName,
    specifier:
      moduleRef.kind === "file"
        ? moduleRef.importPath.split(path.sep).join("/")
        : moduleRef.sourceSpecifier,
  };
}

/**
 * Add Sentry's diagnostics-channel instrumentation to the production bundle.
 *
 * Sentry instruments libraries such as pg, Neon, and the AI SDK through
 * diagnostics channels. Nitro bundles these libraries, so the runtime module
 * hooks of the SDK cannot change them. The Orchestrion plugin adds the
 * channels at build time instead. `@sentry/nitro` does not add this plugin.
 *
 * The bundle does not need the runtime hooks, so the build removes their code.
 * `nitro dev` keeps the runtime hooks from `--import=./instrument.mjs`.
 */
function addSentryBuildTimeInstrumentation(nitro: Nitro): void {
  if (nitro.options.dev) {
    return;
  }
  nitro.options.replace = {
    ...nitro.options.replace,
    __SENTRY_CHANNEL_INJECTION__: "false",
  };
  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    const buildConfig = config as RollupLikeConfig;
    buildConfig.plugins ??= [];
    buildConfig.plugins.push(sentryOrchestrionPlugin());
  });
}

function configureVercelDeployment(
  nitro: Nitro,
  options: JuniorNitroOptions,
): number {
  const defaultMaxDuration =
    options.maxDuration ?? DEFAULT_FUNCTION_MAX_DURATION_SECONDS;
  const queueTopic = resolveConversationWorkQueueTopic({
    topic: options.conversationWorkQueueTopic,
  });

  nitro.options.vercel ??= {};
  nitro.options.vercel.config ??= { version: 3 };
  nitro.options.vercel.config.crons ??= [];
  if (
    !nitro.options.vercel.config.crons.some(
      (cron) => cron.path === JUNIOR_HEARTBEAT_ROUTE,
    )
  ) {
    nitro.options.vercel.config.crons.push({
      path: JUNIOR_HEARTBEAT_ROUTE,
      schedule: JUNIOR_HEARTBEAT_CRON_SCHEDULE,
    });
  }
  if (
    !nitro.options.vercel.config.crons.some(
      (cron) => cron.path === JUNIOR_RETENTION_ROUTE,
    )
  ) {
    nitro.options.vercel.config.crons.push({
      path: JUNIOR_RETENTION_ROUTE,
      schedule: JUNIOR_RETENTION_CRON_SCHEDULE,
    });
  }

  nitro.options.vercel.functions ??= {};
  nitro.options.vercel.functions.maxDuration = defaultMaxDuration;

  nitro.options.vercel.functionRules ??= {};
  const existingRule =
    nitro.options.vercel.functionRules[
      JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE
    ] ?? {};
  const existingTriggers = Array.isArray(existingRule.experimentalTriggers)
    ? existingRule.experimentalTriggers
    : [];
  const otherTriggers = existingTriggers.filter(
    (trigger) => trigger.type !== VERCEL_QUEUE_TRIGGER_TYPE,
  );

  nitro.options.vercel.functionRules[JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE] =
    {
      ...existingRule,
      maxDuration: defaultMaxDuration,
      experimentalTriggers: [
        ...otherTriggers,
        {
          type: VERCEL_QUEUE_TRIGGER_TYPE,
          topic: queueTopic,
        },
      ],
    };

  const existingPluginTaskRule =
    nitro.options.vercel.functionRules[JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE] ?? {};
  const existingPluginTaskTriggers = Array.isArray(
    existingPluginTaskRule.experimentalTriggers,
  )
    ? existingPluginTaskRule.experimentalTriggers
    : [];
  const otherPluginTaskTriggers = existingPluginTaskTriggers.filter(
    (trigger) => trigger.type !== VERCEL_QUEUE_TRIGGER_TYPE,
  );

  nitro.options.vercel.functionRules[JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE] = {
    ...existingPluginTaskRule,
    maxDuration: defaultMaxDuration,
    experimentalTriggers: [
      ...otherPluginTaskTriggers,
      {
        type: VERCEL_QUEUE_TRIGGER_TYPE,
        topic: PLUGIN_TASK_QUEUE_TOPIC,
      },
    ],
  };

  const existingSnapshotJobRule =
    nitro.options.vercel.functionRules[
      JUNIOR_WORKSPACE_SNAPSHOT_JOB_CALLBACK_ROUTE
    ] ?? {};
  const existingSnapshotJobTriggers = Array.isArray(
    existingSnapshotJobRule.experimentalTriggers,
  )
    ? existingSnapshotJobRule.experimentalTriggers
    : [];
  const otherSnapshotJobTriggers = existingSnapshotJobTriggers.filter(
    (trigger) => trigger.type !== VERCEL_QUEUE_TRIGGER_TYPE,
  );

  nitro.options.vercel.functionRules[
    JUNIOR_WORKSPACE_SNAPSHOT_JOB_CALLBACK_ROUTE
  ] = {
    ...existingSnapshotJobRule,
    maxDuration: defaultMaxDuration,
    experimentalTriggers: [
      ...otherSnapshotJobTriggers,
      {
        type: VERCEL_QUEUE_TRIGGER_TYPE,
        topic: WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC,
      },
    ],
  };

  return defaultMaxDuration;
}

/** Nitro module that configures deployment wiring and copies app/plugin content into the Vercel build output. */
export function juniorNitro(options: JuniorNitroOptions = {}): {
  nitro: { setup(nitro: unknown): void };
} {
  return {
    nitro: {
      setup(nitro: Nitro) {
        const cwd = path.resolve(
          options.cwd ?? nitro.options.rootDir ?? process.cwd(),
        );

        const functionMaxDurationSeconds = configureVercelDeployment(
          nitro,
          options,
        );
        addSentryBuildTimeInstrumentation(nitro);

        applyRolldownTreeshakeWorkaround(nitro);
        const pluginSource = options.plugins;
        const pluginModule = isPluginModuleReference(pluginSource)
          ? resolvePluginModule(cwd, pluginSource)
          : undefined;
        const directPluginSet = isPluginSet(pluginSource)
          ? pluginSource
          : undefined;
        if (directPluginSet) {
          assertSerializableDirectPluginSet(directPluginSet);
        }
        let pluginSetPromise: Promise<JuniorPluginSet | undefined> | undefined;
        const loadConfiguredPluginSet = () => {
          pluginSetPromise ??= pluginModule
            ? loadPluginSetFromModule(pluginModule)
            : Promise.resolve(directPluginSet);
          return pluginSetPromise;
        };
        const pluginCatalogConfig =
          pluginCatalogConfigFromPluginSet(directPluginSet);
        const pluginRuntimeRegistrations =
          pluginRuntimeRegistrationsFromPluginSet(directPluginSet).map(
            (plugin) => plugin.manifest.name,
          );
        injectVirtualConfig(nitro, {
          functionMaxDurationSeconds,
          ...(pluginModule
            ? {
                loadPluginSet: loadConfiguredPluginSet,
                pluginModule:
                  runtimeModuleForResolvedPluginModule(pluginModule),
              }
            : undefined),
          plugins: pluginCatalogConfig,
          pluginRuntimeRegistrations,
          dashboard: options.dashboard,
        });

        const copyBuildContent = async () => {
          const pluginSet = await loadConfiguredPluginSet();
          const compiledPluginCatalogConfig =
            pluginCatalogConfigFromPluginSet(pluginSet);
          copyRuntimeContent(
            cwd,
            nitro.options.output.serverDir,
            compiledPluginCatalogConfig?.packages,
          );
          if (dashboardEnabled(options.dashboard)) {
            copyDashboardAssets(cwd, nitro.options.output.serverDir);
          }
          copyIncludedFiles(
            cwd,
            nitro.options.output.serverDir,
            options.includeFiles,
          );
        };

        nitro.hooks.hook("rollup:before", (_nitro, config) => {
          const buildConfig = config as RollupLikeConfig;
          buildConfig.plugins ??= [];
          buildConfig.plugins.push({
            name: "junior:copy-build-content",
            async writeBundle() {
              await copyBuildContent();
            },
          });
        });
      },
    },
  };
}
