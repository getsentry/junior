import type { NextConfig } from "next";
import { createRequire } from "node:module";
import path from "node:path";
import { discoverNodeModulesDirs } from "@/chat/discovery-roots";
import { isDirectory } from "@/chat/fs-utils";
import { discoverInstalledPluginPackageContent } from "./chat/plugins/package-discovery";

const require = createRequire(import.meta.url);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Optional overrides for `withJunior`.
 */
export interface JuniorConfigOptions {
  dataDir?: string;
  skillsDir?: string;
  pluginsDir?: string;
  pluginPackages?: string[];
}

type NextConfigFactory = (
  phase: string,
  ctx: { defaultConfig: NextConfig },
) => Promise<NextConfig> | NextConfig;

function sentryConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN);
}

function isPackageInstalled(cwd: string, packageName: string): boolean {
  const nodeModulesDirs = discoverNodeModulesDirs(cwd);
  return nodeModulesDirs.some((nodeModulesDir) =>
    isDirectory(path.join(nodeModulesDir, ...packageName.split("/"))),
  );
}

function applyJuniorConfig(
  nextConfig: NextConfig | undefined,
  options?: JuniorConfigOptions,
): NextConfig {
  const existingEnv =
    (nextConfig as { env?: Record<string, string> } | undefined)?.env ?? {};
  const dataDir = options?.dataDir ?? "./app/data";
  const skillsDir = options?.skillsDir ?? "./app/skills";
  const pluginsDir = options?.pluginsDir ?? "./app/plugins";
  const configuredPluginPackages = unique(options?.pluginPackages ?? []);
  const discoveredPlugins = discoverInstalledPluginPackageContent(
    process.cwd(),
    { packageNames: configuredPluginPackages },
  );
  const unresolvedConfiguredPackages = configuredPluginPackages.filter(
    (packageName) => !discoveredPlugins.packageNames.includes(packageName),
  );
  const invalidPluginPackages = unresolvedConfiguredPackages.filter(
    (packageName) => isPackageInstalled(process.cwd(), packageName),
  );
  const missingPluginPackages = unresolvedConfiguredPackages.filter(
    (packageName) => !invalidPluginPackages.includes(packageName),
  );
  if (invalidPluginPackages.length > 0) {
    throw new Error(
      `withJunior pluginPackages contains installed packages that are not valid Junior plugins: ${invalidPluginPackages.join(", ")}`,
    );
  }
  if (missingPluginPackages.length > 0) {
    throw new Error(
      `withJunior pluginPackages contains unresolved packages: ${missingPluginPackages.join(", ")}`,
    );
  }
  const defaultDataTracingIncludes = options?.dataDir
    ? [`${dataDir}/**/*`]
    : ["./app/SOUL.md", "./app/ABOUT.md"];
  const pluginPackageTracingIncludes = discoveredPlugins.tracingIncludes;
  const tracingIncludes = Array.from(
    new Set([
      ...defaultDataTracingIncludes,
      `${skillsDir}/**/*`,
      `${pluginsDir}/**/*`,
      ...pluginPackageTracingIncludes,
    ]),
  );
  const existingGlobalTracingIncludes =
    nextConfig?.outputFileTracingIncludes?.["/*"] ?? [];
  const mergedGlobalTracingIncludes = Array.from(
    new Set([...existingGlobalTracingIncludes, ...tracingIncludes]),
  );
  const config = {
    ...nextConfig,
    serverExternalPackages: Array.from(
      new Set([
        ...(nextConfig?.serverExternalPackages ?? []),
        "@vercel/queue",
        "@vercel/sandbox",
        "bash-tool",
        "just-bash",
        "@mariozechner/pi-agent-core",
        "@mariozechner/pi-ai",
        "@chat-adapter/slack",
        "@slack/web-api",
      ]),
    ),
    outputFileTracingIncludes: {
      ...nextConfig?.outputFileTracingIncludes,
      "/*": mergedGlobalTracingIncludes,
    },
    env: {
      ...existingEnv,
      JUNIOR_PLUGIN_PACKAGES: JSON.stringify(configuredPluginPackages),
    },
  } as NextConfig;

  if (!sentryConfigured()) {
    return config;
  }

  const { withSentryConfig } =
    require("@sentry/nextjs") as typeof import("@sentry/nextjs");
  return withSentryConfig(config, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    silent: !process.env.CI,
    sourcemaps: {
      disable: false,
    },
  });
}

/**
 * Extends a Next.js config with Junior runtime defaults.
 *
 * Supports both object and function-style Next config exports.
 */
export function withJunior(
  options?: JuniorConfigOptions,
  nextConfig?: NextConfig | NextConfigFactory,
): NextConfig | NextConfigFactory {
  if (typeof nextConfig === "function") {
    return async (phase, ctx) => {
      const resolved = await nextConfig(phase, ctx);
      return applyJuniorConfig(resolved, options);
    };
  }

  return applyJuniorConfig(nextConfig, options);
}
