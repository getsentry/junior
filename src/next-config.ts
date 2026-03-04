import type { NextConfig } from "next";

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
  const dataDir = options?.dataDir ?? "./data";
  const skillsDir = options?.skillsDir ?? "./skills";
  const pluginsDir = options?.pluginsDir ?? "./plugins";
  const tracingIncludes = Array.from(new Set([
    `${dataDir}/**/*`,
    `${skillsDir}/**/*`,
    `${pluginsDir}/**/*`
  ]));
  const existingApiTracingIncludes = nextConfig?.outputFileTracingIncludes?.["/api/**"] ?? [];
  const mergedApiTracingIncludes = Array.from(new Set([...existingApiTracingIncludes, ...tracingIncludes]));

  const config: NextConfig = {
    ...nextConfig,
    serverExternalPackages: [
      ...(nextConfig?.serverExternalPackages ?? []),
      "@vercel/sandbox",
      "bash-tool",
      "just-bash"
    ],
    outputFileTracingIncludes: {
      ...nextConfig?.outputFileTracingIncludes,
      "/api/**": mergedApiTracingIncludes
    }
  };

  if (options?.sentry) {
    // Dynamic import to avoid requiring @sentry/nextjs when not used
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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
