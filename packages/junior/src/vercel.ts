import { writeFileSync } from "node:fs";
import path from "node:path";
import { discoverInstalledPluginPackageContent } from "@/chat/plugins/package-discovery";

export interface JuniorVercelConfigOptions {
  cwd?: string;
  entrypoint?: string;
  maxDuration?: number;
  buildCommand?: string | null;
}

/** Return the default Vercel config used by scaffolded Junior apps. */
export function juniorVercelConfig(options: JuniorVercelConfigOptions = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const entrypoint = options.entrypoint ?? "server.ts";
  const maxDuration = options.maxDuration ?? 800;
  const buildCommand =
    options.buildCommand === undefined ? "pnpm build" : options.buildCommand;

  const packagedContent = discoverInstalledPluginPackageContent(cwd);

  const includeGlobs = ["./app/**/*", ...packagedContent.tracingIncludes];
  const includeFiles =
    includeGlobs.length === 1 ? includeGlobs[0] : `{${includeGlobs.join(",")}}`;

  const config: Record<string, unknown> = {
    framework: "hono",
    functions: {
      [entrypoint]: {
        maxDuration,
        includeFiles,
      },
    },
  };

  if (buildCommand !== null) {
    config.buildCommand = buildCommand;
  }

  return config;
}

/** Write vercel.json to the given directory using discovered plugin config. */
export function writeVercelJson(
  options: JuniorVercelConfigOptions = {},
): string {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const config = juniorVercelConfig(options);
  const target = path.join(cwd, "vercel.json");
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  return target;
}
