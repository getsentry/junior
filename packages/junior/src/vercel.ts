export interface JuniorVercelConfigOptions {
  entrypoint?: string;
  maxDuration?: number;
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
      },
    },
  };

  if (buildCommand !== null) {
    config.buildCommand = buildCommand;
  }

  return config;
}
