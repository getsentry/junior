import type { NextConfig } from "next";

export interface JuniorConfigOptions {
  home?: string;
  sentry?: boolean;
}

export function withJunior(nextConfig?: NextConfig, options?: JuniorConfigOptions): NextConfig {
  const home = options?.home ?? ".";

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
      "/api/**": [`${home}/**/*`]
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
