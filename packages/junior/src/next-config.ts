import type { NextConfig } from "next";
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

interface RootPackageJson {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function isDirectory(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(targetPath: string): boolean {
  try {
    return statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function discoverInstalledPluginPackageTracingIncludes(cwd: string = process.cwd()): string[] {
  const rootPackageJsonPath = path.join(cwd, "package.json");
  let rootPackageJson: RootPackageJson | undefined;
  try {
    rootPackageJson = JSON.parse(readFileSync(rootPackageJsonPath, "utf8")) as RootPackageJson;
  } catch {
    return [];
  }

  const dependencies = [
    ...Object.keys(rootPackageJson.dependencies ?? {}),
    ...Object.keys(rootPackageJson.optionalDependencies ?? {})
  ];
  const tracingIncludes: string[] = [];

  for (const dependency of dependencies) {
    const packageDir = path.join(cwd, "node_modules", ...dependency.split("/"));
    if (!isDirectory(packageDir)) {
      continue;
    }

    const base = `./node_modules/${dependency}`;
    if (isFile(path.join(packageDir, "plugin.yaml"))) {
      tracingIncludes.push(`${base}/plugin.yaml`);
    }
    if (isDirectory(path.join(packageDir, "plugins"))) {
      tracingIncludes.push(`${base}/plugins/**/*`);
    }
    if (isDirectory(path.join(packageDir, "skills"))) {
      tracingIncludes.push(`${base}/skills/**/*`);
    }
  }

  return [...new Set(tracingIncludes)].sort((left, right) => left.localeCompare(right));
}

/**
 * Optional overrides for `withJunior`.
 */
export interface JuniorConfigOptions {
  dataDir?: string;
  skillsDir?: string;
  pluginsDir?: string;
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
  const pluginPackageTracingIncludes = discoverInstalledPluginPackageTracingIncludes();
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
      "@vercel/sandbox",
      "bash-tool",
      "just-bash",
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
