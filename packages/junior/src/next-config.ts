import type { NextConfig } from "next";
import { createRequire } from "node:module";
import { withWorkflow } from "workflow/next";

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

const WORKFLOW_FACTORY_NAME = "buildConfig";

function isWorkflowWrappedFactory(config: NextConfig | NextConfigFactory | undefined): config is NextConfigFactory {
  if (typeof config !== "function") {
    return false;
  }

  if (config.name !== WORKFLOW_FACTORY_NAME) {
    return false;
  }

  // withWorkflow currently emits a buildConfig wrapper that resolves "./loader".
  // Detect this shape to avoid wrapping an already-workflow-enabled config twice.
  const source = Function.prototype.toString.call(config);
  return source.includes("require.resolve('./loader')") || source.includes('require.resolve("./loader")');
}

function ensureWorkflowConfig(nextConfig: NextConfig | NextConfigFactory | undefined): NextConfigFactory {
  if (isWorkflowWrappedFactory(nextConfig)) {
    return nextConfig;
  }

  return withWorkflow(nextConfig ?? {}) as NextConfigFactory;
}

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
    transpilePackages: Array.from(new Set([...(nextConfig?.transpilePackages ?? []), "junior"])),
    serverExternalPackages: Array.from(new Set([
      ...(nextConfig?.serverExternalPackages ?? []),
      "@vercel/sandbox",
      "bash-tool",
      "just-bash"
    ])),
    outputFileTracingIncludes: {
      ...nextConfig?.outputFileTracingIncludes,
      "/api/**": mergedApiTracingIncludes
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
  const workflowConfig = ensureWorkflowConfig(nextConfig);
  return async (phase, ctx) => {
    const resolved = await workflowConfig(phase, ctx);
    return applyJuniorConfig(resolved, options);
  };
}
