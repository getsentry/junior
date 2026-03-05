import type { NextConfig } from "next";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function getNodeModulesRoots(): string[] {
  const roots: string[] = [];
  let current = process.cwd();

  while (true) {
    roots.push(path.join(current, "node_modules"));
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return Array.from(new Set(roots));
}

function resolveTracingPatternsForPackage(packageName: string): string[] {
  const patterns: string[] = [];
  for (const nodeModulesRoot of getNodeModulesRoots()) {
    const packageDir = path.join(nodeModulesRoot, packageName);
    if (!fs.existsSync(packageDir)) {
      continue;
    }

    const relativeDir = toPosixPath(path.relative(process.cwd(), packageDir));
    const relativePattern = relativeDir.startsWith(".") || relativeDir.startsWith("..")
      ? `${relativeDir}/**/*`
      : `./${relativeDir}/**/*`;
    const absolutePattern = `${toPosixPath(packageDir)}/**/*`;
    patterns.push(relativePattern, absolutePattern);
  }

  if (patterns.length === 0) {
    throw new Error(`Unable to resolve package directory for output tracing: ${packageName}`);
  }

  return Array.from(new Set(patterns));
}

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
  const slackRuntimeTracingIncludes = [
    ...resolveTracingPatternsForPackage("@chat-adapter/slack"),
    ...resolveTracingPatternsForPackage("@slack/web-api")
  ];
  const tracingIncludes = Array.from(new Set([
    `${dataDir}/**/*`,
    `${skillsDir}/**/*`,
    `${pluginsDir}/**/*`,
    ...slackRuntimeTracingIncludes
  ]));
  const existingGlobalTracingIncludes = nextConfig?.outputFileTracingIncludes?.["/*"] ?? [];
  const mergedGlobalTracingIncludes = Array.from(new Set([
    ...existingGlobalTracingIncludes,
    ...tracingIncludes
  ]));

  const config: NextConfig = {
    ...nextConfig,
    transpilePackages: Array.from(new Set([...(nextConfig?.transpilePackages ?? []), "junior"])),
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
