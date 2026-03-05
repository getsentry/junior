import type { NextConfig } from "next";
import { createRequire } from "node:module";
import { discoverInstalledPluginPackageContent } from "@/chat/plugins/package-discovery";

const require = createRequire(import.meta.url);

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
  const pluginPackageTracingIncludes = discoverInstalledPluginPackageContent().tracingIncludes;
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
