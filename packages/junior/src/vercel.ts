/** Default glob for bundling app content and plugin packages into the Vercel function. */
/** Default glob for bundling app content and plugin package assets into the Vercel function. */
export const DEFAULT_INCLUDE_FILES =
  "{./app/**,./node_modules/@sentry/junior*/plugin.yaml,./node_modules/@sentry/junior*/skills/**,./node_modules/@sentry/junior*/plugins/**}";

export interface JuniorVercelConfigOptions {
  entrypoint?: string;
  maxDuration?: number;
  includeFiles?: string;
  buildCommand?: string | null;
}

/** Return the default Vercel config used by scaffolded Junior apps. */
export function juniorVercelConfig(options: JuniorVercelConfigOptions = {}) {
  const entrypoint = options.entrypoint ?? "server.ts";
  const maxDuration = options.maxDuration ?? 800;
  const buildCommand =
    options.buildCommand === undefined ? "pnpm build" : options.buildCommand;

  const config: Record<string, unknown> = {
    framework: "hono",
    functions: {
      [entrypoint]: {
        maxDuration,
        includeFiles: options.includeFiles ?? DEFAULT_INCLUDE_FILES,
      },
    },
  };

  if (buildCommand !== null) {
    config.buildCommand = buildCommand;
  }

  return config;
}
