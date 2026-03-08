import type { NextConfig } from "next";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { discoverInstalledPluginPackageContent } from "./chat/plugins/package-discovery";

const require = createRequire(import.meta.url);

interface RootPackageJson {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readDeclaredDependencyNames(cwd: string = process.cwd()): string[] {
  const packageJsonPath = path.join(cwd, "package.json");
  try {
    const rootPackage = JSON.parse(readFileSync(packageJsonPath, "utf8")) as RootPackageJson;
    return [...new Set([
      ...Object.keys(rootPackage.dependencies ?? {}),
      ...Object.keys(rootPackage.optionalDependencies ?? {})
    ])].sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function discoverInstalledPluginPackages(cwd: string = process.cwd()): { tracingIncludes: string[] } {
  const packageNames = readDeclaredDependencyNames(cwd);
  const discovered = discoverInstalledPluginPackageContent(cwd, { packageNames });
  return {
    tracingIncludes: discovered.tracingIncludes
  };
}

/**
 * Optional overrides for `withJunior`.
 */
export interface JuniorConfigOptions {
  dataDir?: string;
  skillsDir?: string;
  pluginsDir?: string;
  pluginPackages?: string[];
  sentry?: boolean;
}

type NextConfigFactory = (
  phase: string,
  ctx: { defaultConfig: NextConfig }
) => Promise<NextConfig> | NextConfig;

function applyJuniorConfig(nextConfig: NextConfig | undefined, options?: JuniorConfigOptions): NextConfig {
  const dataDir = options?.dataDir ?? "./app/data";
  const skillsDir = options?.skillsDir ?? "./app/skills";
  const pluginsDir = options?.pluginsDir ?? "./app/plugins";
  const defaultDataTracingIncludes = options?.dataDir
    ? [`${dataDir}/**/*`]
    : ["./app/SOUL.md", "./app/ABOUT.md"];
  const discoveredPlugins = options?.pluginPackages && options.pluginPackages.length > 0
    ? discoverInstalledPluginPackageContent(process.cwd(), { packageNames: options.pluginPackages })
    : discoverInstalledPluginPackages();
  const pluginPackageTracingIncludes = discoveredPlugins.tracingIncludes;
  const tracingIncludes = Array.from(new Set([
    ...defaultDataTracingIncludes,
    `${skillsDir}/**/*`,
    `${pluginsDir}/**/*`,
    ...pluginPackageTracingIncludes,
  ]));
  const existingGlobalTracingIncludes = nextConfig?.outputFileTracingIncludes?.["/*"] ?? [];
  const mergedGlobalTracingIncludes = Array.from(new Set([
    ...existingGlobalTracingIncludes,
    ...tracingIncludes
  ]));
  const config: NextConfig = {
    ...nextConfig,
    serverExternalPackages: Array.from(new Set([
      ...(nextConfig?.serverExternalPackages ?? []),
      "@vercel/queue",
      "@vercel/sandbox",
      "bash-tool",
      "just-bash",
      "@mariozechner/pi-agent-core",
      "@mariozechner/pi-ai",
      "@chat-adapter/slack",
      "@slack/web-api"
    ])),
    outputFileTracingIncludes: {
      ...nextConfig?.outputFileTracingIncludes,
      "/*": mergedGlobalTracingIncludes
    }
  };

  if (options?.sentry) {
    // Conditionally load @sentry/nextjs only when Sentry integration is enabled.
    const { withSentryConfig } = require("@sentry/nextjs") as typeof import("@sentry/nextjs");
    return withSentryConfig(config, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
      sourcemaps: {
        disable: false
      }
    });
  }

  return config;
}

/**
 * Extends a Next.js config with Junior runtime defaults.
 *
 * Supports both object and function-style Next config exports.
 */
export function withJunior(
  nextConfig?: NextConfig | NextConfigFactory,
  options?: JuniorConfigOptions
): NextConfig | NextConfigFactory {
  if (typeof nextConfig === "function") {
    return async (phase, ctx) => {
      const resolved = await nextConfig(phase, ctx);
      return applyJuniorConfig(resolved, options);
    };
  }

  return applyJuniorConfig(nextConfig, options);
}
