export interface JuniorVercelConfigOptions {
  buildCommand?: string | null;
}

/** Return a minimal Vercel config for scaffolded Junior apps. */
export function juniorVercelConfig(options: JuniorVercelConfigOptions = {}) {
  const buildCommand =
    options.buildCommand === undefined ? "pnpm build" : options.buildCommand;

  const config: Record<string, unknown> = {
    framework: "nitro",
  };

  if (buildCommand !== null) {
    config.buildCommand = buildCommand;
  }

  return config;
}
