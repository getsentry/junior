export interface JuniorVercelConfigOptions {
  /** Override the Vercel build command, or pass null to omit it. */
  buildCommand?: string | null;
}

/** Return the root Vercel project config for scaffolded Junior apps.
 *
 * New apps run `junior upgrade` before `pnpm build`; older installs without
 * Junior SQL configured can override `buildCommand` to keep their prior build.
 */
export function juniorVercelConfig(options: JuniorVercelConfigOptions = {}) {
  const buildCommand =
    options.buildCommand === undefined
      ? "pnpm exec junior upgrade && pnpm build"
      : options.buildCommand;

  const config: Record<string, unknown> = {
    framework: "nitro",
  };

  if (buildCommand !== null) {
    config.buildCommand = buildCommand;
  }

  return config;
}
