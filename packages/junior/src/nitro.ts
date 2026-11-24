import path from "node:path";
import { withSentryConfig as withSentryNitroConfig } from "@sentry/nitro";
import { sentryOrchestrionPlugin } from "@sentry/server-utils/orchestrion/rollup";
import type { Nitro } from "nitro/types";
import { startDevQueue } from "@/build/dev-queue";
import { applyRolldownTreeshakeWorkaround } from "@/build/rolldown-workarounds";
import {
  copyIncludedFiles,
  copyRuntimeContent,
  resolveDashboardPublicAssetsDir,
} from "@/build/copy-build-content";
import {
  injectVirtualConfig,
  type RuntimePluginModule,
} from "@/build/virtual-config";
import { injectVirtualSystemPrompts } from "@/build/virtual-system-prompts";
import { queueCallbackRoutes } from "@/chat/queue/routes";
import {
  JUNIOR_AUTO_ARCHIVE_CRON_SCHEDULE,
  JUNIOR_AUTO_ARCHIVE_ROUTE,
  JUNIOR_HEARTBEAT_CRON_SCHEDULE,
  JUNIOR_HEARTBEAT_ROUTE,
  JUNIOR_RETENTION_CRON_SCHEDULE,
  JUNIOR_RETENTION_ROUTE,
  getDeploymentServiceVersion,
} from "@/deployment";
import {
  pluginCatalogConfigFromPluginSet,
  pluginRuntimeRegistrationsFromPluginSet,
  type JuniorPluginSet,
} from "./plugins";
import { loadPluginSetFromModule, resolvePluginModule } from "./plugin-module";
import type { JuniorDashboardOptions } from "./app";

type SentryNitroConfig = Parameters<typeof withSentryNitroConfig>[0];
type SentryNitroOptions = NonNullable<
  Parameters<typeof withSentryNitroConfig>[1]
>;

/**
 * Sentry's Nitro config wrapper: source map upload and Nitro request hooks.
 * Junior pins `@sentry/nitro` to the same version as its `@sentry/node`. The
 * SDK keeps one client for each version, so this lets the Nitro hooks use the
 * client that `initSentry()` creates. Apps import it from here, not from
 * `@sentry/nitro`.
 *
 * The build release defaults to the release that `initSentry()` reports, so
 * the uploaded source maps and the runtime events use the same release.
 */
export function withSentryConfig(
  config: SentryNitroConfig,
  options: SentryNitroOptions = {},
): SentryNitroConfig {
  return withSentryNitroConfig(bundleSentryNitroRuntime(config), {
    ...options,
    release: { name: getDeploymentServiceVersion(), ...options.release },
  });
}

// `@sentry/nitro` adds its runtime plugin from `node_modules`, and since
// 11.11.0 that plugin imports the virtual module `#nitro/virtual/tasks`.
// `nitro dev` keeps `node_modules` files external, so Node loads the plugin
// and fails with ERR_PACKAGE_IMPORT_NOT_DEFINED. Production builds already
// bundle it. TODO: Remove when `@sentry/nitro` marks its runtime noExternal.
const SENTRY_NITRO_RUNTIME =
  /[/\\]@sentry[/\\]nitro[/\\]build[/\\]esm[/\\]runtime[/\\]/;

function bundleSentryNitroRuntime(
  config: SentryNitroConfig,
): SentryNitroConfig {
  if (config.noExternals === true) return config;
  return {
    ...config,
    noExternals: [...(config.noExternals || []), SENTRY_NITRO_RUNTIME],
  };
}

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
// Code Mode loads `quickjs.wasm` and its worker file from the installed
// packages at run time. A trailing `*` tells Nitro to keep these packages
// external and copy each whole package into the server output.
const CODEMODE_TRACE_DEPS = ["@earendil-works/pi-codemode*", "quickjs-wasi*"];

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

function configureVercelDeployment(
  nitro: Nitro,
  options: JuniorNitroOptions,
): number {
  const defaultMaxDuration =
    options.maxDuration ?? DEFAULT_FUNCTION_MAX_DURATION_SECONDS;

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
  if (
    !nitro.options.vercel.config.crons.some(
      (cron) => cron.path === JUNIOR_AUTO_ARCHIVE_ROUTE,
    )
  ) {
    nitro.options.vercel.config.crons.push({
      path: JUNIOR_AUTO_ARCHIVE_ROUTE,
      schedule: JUNIOR_AUTO_ARCHIVE_CRON_SCHEDULE,
    });
  }

  nitro.options.vercel.functions ??= {};
  nitro.options.vercel.functions.maxDuration = defaultMaxDuration;

  nitro.options.vercel.functionRules ??= {};
  const functionRules = nitro.options.vercel.functionRules;
  // Each queue topic pushes to one callback route. Keep the other triggers of
  // that route.
  for (const { route, topic } of queueCallbackRoutes()) {
    const existingRule = functionRules[route] ?? {};
    const existingTriggers = Array.isArray(existingRule.experimentalTriggers)
      ? existingRule.experimentalTriggers
      : [];
    functionRules[route] = {
      ...existingRule,
      maxDuration: defaultMaxDuration,
      experimentalTriggers: [
        ...existingTriggers.filter(
          (trigger) => trigger.type !== VERCEL_QUEUE_TRIGGER_TYPE,
        ),
        { type: VERCEL_QUEUE_TRIGGER_TYPE, topic },
      ],
    };
  }

  return defaultMaxDuration;
}

// Apps route `/**` to `./server.ts`, and Nitro also detects `server.ts` as
// its server entry. With both, a 404 from the app runs the app again with the
// same Request, whose body the first run may already have read.
function dropRoutedServerEntry(nitro: Nitro): void {
  const serverEntry = nitro.options.serverEntry;
  if (!serverEntry) {
    return;
  }
  const routed = Object.values(nitro.options.routes).some(
    (route) =>
      (typeof route === "string" ? route : route.handler) ===
      serverEntry.handler,
  );
  if (routed) {
    nitro.options.serverEntry = false;
  }
}

/** Nitro module that configures deployment wiring and copies app/plugin content into the Vercel build output. */
export function juniorNitro(options: JuniorNitroOptions = {}): {
  nitro: { setup(nitro: unknown): void | Promise<void> };
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

        dropRoutedServerEntry(nitro);
        applyRolldownTreeshakeWorkaround(nitro);
        if (dashboardEnabled(options.dashboard)) {
          // Nitro resolves configured public assets before modules run, so
          // this entry must already have its final shape. The dashboard
          // package serves the same files from `/_junior/dashboard/assets/*`
          // when no static file matches.
          nitro.options.publicAssets.push({
            baseURL: "/_junior/dashboard/assets",
            dir: resolveDashboardPublicAssetsDir(cwd),
            fallthrough: false,
            maxAge: 31_536_000,
          });
        }
        nitro.options.traceDeps = [
          ...(nitro.options.traceDeps ?? []),
          ...CODEMODE_TRACE_DEPS,
        ];
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
        injectVirtualSystemPrompts(nitro, async () =>
          pluginRuntimeRegistrationsFromPluginSet(
            await loadConfiguredPluginSet(),
          ),
        );

        const copyBuildContent = async () => {
          const pluginSet = await loadConfiguredPluginSet();
          const compiledPluginCatalogConfig =
            pluginCatalogConfigFromPluginSet(pluginSet);
          copyRuntimeContent(
            cwd,
            nitro.options.output.serverDir,
            compiledPluginCatalogConfig?.packages,
          );
          copyIncludedFiles(
            cwd,
            nitro.options.output.serverDir,
            options.includeFiles,
          );
        };

        nitro.hooks.hook("rollup:before", (_nitro, config) => {
          const buildConfig = config as RollupLikeConfig;
          buildConfig.plugins ??= [];
          buildConfig.plugins.push(sentryOrchestrionPlugin());
          buildConfig.plugins.push({
            name: "junior:copy-build-content",
            async writeBundle() {
              await copyBuildContent();
            },
          });
        });

        return nitro.options.dev ? startDevQueue(nitro) : undefined;
      },
    },
  };
}
