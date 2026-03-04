// src/next-config.ts
import { createRequire } from "module";
var require2 = createRequire(import.meta.url);
function applyJuniorConfig(nextConfig, options) {
  const dataDir = options?.dataDir ?? "./data";
  const skillsDir = options?.skillsDir ?? "./skills";
  const pluginsDir = options?.pluginsDir ?? "./plugins";
  const tracingIncludes = Array.from(/* @__PURE__ */ new Set([
    `${dataDir}/**/*`,
    `${skillsDir}/**/*`,
    `${pluginsDir}/**/*`
  ]));
  const existingGlobalTracingIncludes = nextConfig?.outputFileTracingIncludes?.["/*"] ?? [];
  const mergedGlobalTracingIncludes = Array.from(/* @__PURE__ */ new Set([
    ...existingGlobalTracingIncludes,
    ...tracingIncludes
  ]));
  const config = {
    ...nextConfig,
    transpilePackages: Array.from(/* @__PURE__ */ new Set([...nextConfig?.transpilePackages ?? [], "junior"])),
    serverExternalPackages: Array.from(/* @__PURE__ */ new Set([
      ...nextConfig?.serverExternalPackages ?? [],
      "@vercel/sandbox",
      "bash-tool",
      "just-bash"
    ])),
    outputFileTracingIncludes: {
      ...nextConfig?.outputFileTracingIncludes,
      "/*": mergedGlobalTracingIncludes
    }
  };
  if (options?.sentry) {
    const { withSentryConfig } = require2("@sentry/nextjs");
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
function withJunior(nextConfig, options) {
  if (typeof nextConfig === "function") {
    return async (phase, ctx) => {
      const resolved = await nextConfig(phase, ctx);
      return applyJuniorConfig(resolved, options);
    };
  }
  return applyJuniorConfig(nextConfig, options);
}
export {
  withJunior
};
