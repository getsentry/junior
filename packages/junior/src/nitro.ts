import path from "node:path";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Nitro } from "nitro/types";
import { applyRolldownTreeshakeWorkaround } from "@/build/rolldown-workarounds";
import {
  copyAppAndPluginContent,
  copyIncludedFiles,
} from "@/build/copy-build-content";
import {
  injectVirtualConfig,
  type RuntimePluginModule,
} from "@/build/virtual-config";
import { resolveConversationWorkQueueTopic } from "@/chat/task-execution/vercel-queue";
import {
  JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE,
  JUNIOR_HEARTBEAT_CRON_SCHEDULE,
  JUNIOR_HEARTBEAT_ROUTE,
} from "@/deployment";
import {
  pluginCatalogConfigFromPluginSet,
  pluginHookRegistrationsFromPluginSet,
  type JuniorPluginSet,
} from "@/plugins";

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
  maxDuration?: number;
  /** Vercel Queue topic for durable conversation work. Must match the runtime queue producer topic. */
  conversationWorkQueueTopic?: string;
  /** Plugin catalog set or runtime-safe plugin module. Direct sets must not include runtime hooks. */
  plugins?: JuniorNitroPluginSource;
  /**
   * Extra file patterns to copy into the server output for files that the
   * bundler cannot trace (e.g. dynamically imported providers).
   * Each entry is `"<package-name>/<subpath-glob>"`, resolved via Node
   * module resolution. Example: `"@earendil-works/pi-ai/dist/providers/*.js"`
   */
  includeFiles?: string[];
}

interface ResolvedPluginModuleReference {
  exportName: string;
  importUrl: string;
  runtimeModule: RuntimePluginModule;
}

type RollupLikeConfig = {
  plugins?: unknown[];
};

const DEFAULT_FUNCTION_MAX_DURATION_SECONDS = 300;
const VERCEL_QUEUE_TRIGGER_TYPE = "queue/v2beta";

const PLUGIN_MODULE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".mjs",
  ".js",
  ".cjs",
];

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

function resolveRelativePluginModule(cwd: string, specifier: string): string {
  const basePath = path.resolve(cwd, specifier);
  for (const extension of PLUGIN_MODULE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next extension.
    }
  }
  for (const extension of PLUGIN_MODULE_EXTENSIONS) {
    const candidate = path.join(basePath, `index${extension}`);
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next extension.
    }
  }

  throw new Error(`Plugin module "${specifier}" could not be resolved`);
}

function resolvePluginModule(
  cwd: string,
  input: JuniorPluginModuleReference | string,
): ResolvedPluginModuleReference {
  const moduleSpecifier = typeof input === "string" ? input : input.module;
  const exportName =
    typeof input === "string" ? "plugins" : (input.exportName ?? "plugins");
  if (!moduleSpecifier.trim()) {
    throw new Error("Plugin module specifier must not be empty");
  }

  if (moduleSpecifier.startsWith(".") || path.isAbsolute(moduleSpecifier)) {
    const resolvedPath = resolveRelativePluginModule(cwd, moduleSpecifier);
    return {
      exportName,
      importUrl: pathToFileURL(resolvedPath).href,
      runtimeModule: {
        exportName,
        specifier: resolvedPath.split(path.sep).join("/"),
      },
    };
  }

  const requireFromApp = createRequire(path.join(cwd, "package.json"));
  const resolvedPath = requireFromApp.resolve(moduleSpecifier);
  return {
    exportName,
    importUrl: pathToFileURL(resolvedPath).href,
    runtimeModule: {
      exportName,
      specifier: moduleSpecifier,
    },
  };
}

function assertPluginSet(value: unknown, source: string): JuniorPluginSet {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as Partial<JuniorPluginSet>).packageNames) ||
    !Array.isArray((value as Partial<JuniorPluginSet>).registrations)
  ) {
    throw new Error(
      `Plugin module ${source} must export a defineJuniorPlugins(...) set`,
    );
  }

  return value as JuniorPluginSet;
}

async function loadPluginSetFromModule(
  moduleRef: ResolvedPluginModuleReference,
): Promise<JuniorPluginSet> {
  const mod = (await import(moduleRef.importUrl)) as Record<string, unknown>;
  const value =
    moduleRef.exportName === "default"
      ? (mod.default as unknown)
      : mod[moduleRef.exportName];
  return assertPluginSet(
    value,
    `${moduleRef.importUrl}#${moduleRef.exportName}`,
  );
}

function assertSerializableDirectPluginSet(pluginSet: JuniorPluginSet): void {
  const pluginHookNames = pluginHookRegistrationsFromPluginSet(pluginSet).map(
    (plugin) => plugin.name,
  );
  if (pluginHookNames.length === 0) {
    return;
  }

  throw new Error(
    `juniorNitro({ plugins }) cannot receive a direct defineJuniorPlugins(...) set with runtime hook registration(s): ${pluginHookNames.join(", ")}. Export the set from a runtime-safe plugin module and pass juniorNitro({ plugins: "./plugins" }) so createApp() can import the same hooks at runtime.`,
  );
}

/**
 * Prevent import-in-the-middle and require-in-the-middle from being
 * externalized so Rolldown bundles them inline.
 *
 * @sentry/node (via @opentelemetry/instrumentation) statically imports these
 * packages. Nitro already lists them in nf3's NonBundleablePackages, which
 * means it externalizes them and relies on traceNodeModules to copy the
 * package directories into the Vercel function output. In practice that trace
 * step fails to materialize the packages at runtime, causing an
 * ERR_MODULE_NOT_FOUND startup crash.
 *
 * Adding them to noExternals overrides the NonBundleablePackages default and
 * forces Rolldown to bundle their CJS code inline. The trade-off is that
 * Node.js ESM loader hooks (hook.mjs) are not active, which limits OTEL
 * auto-instrumentation of modules loaded after initialization. That is an
 * acceptable cost compared to a fatal startup failure.
 */
function bundleOpenTelemetryLoaderHooks(nitro: Nitro): void {
  const existing = Array.isArray(nitro.options.noExternals)
    ? nitro.options.noExternals
    : [];
  const additions = ["import-in-the-middle", "require-in-the-middle"].filter(
    (pkg) => !existing.includes(pkg),
  );
  if (additions.length > 0) {
    nitro.options.noExternals = [...existing, ...additions];
  }
}

function configureVercelDeployment(nitro: Nitro, options: JuniorNitroOptions) {
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

  nitro.options.vercel.functions ??= {};
  nitro.options.vercel.functions.maxDuration ??= defaultMaxDuration;
  const callbackMaxDuration =
    nitro.options.vercel.functions.maxDuration ?? defaultMaxDuration;

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
      maxDuration: callbackMaxDuration,
      ...existingRule,
      experimentalTriggers: [
        ...otherTriggers,
        {
          type: VERCEL_QUEUE_TRIGGER_TYPE,
          topic: queueTopic,
        },
      ],
    };
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

        configureVercelDeployment(nitro, options);
        bundleOpenTelemetryLoaderHooks(nitro);

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
        const pluginHookRegistrations = pluginHookRegistrationsFromPluginSet(
          directPluginSet,
        ).map((plugin) => plugin.name);
        injectVirtualConfig(nitro, {
          ...(pluginModule
            ? {
                loadPluginSet: loadConfiguredPluginSet,
                pluginModule: pluginModule.runtimeModule,
              }
            : {}),
          plugins: pluginCatalogConfig,
          pluginHookRegistrations,
        });

        const copyBuildContent = async () => {
          const pluginSet = await loadConfiguredPluginSet();
          const compiledPluginCatalogConfig =
            pluginCatalogConfigFromPluginSet(pluginSet);
          copyAppAndPluginContent(
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
