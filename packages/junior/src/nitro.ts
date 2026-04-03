import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { discoverInstalledPluginPackageContent } from "@/chat/plugins/package-discovery";
import type { Nitro } from "nitro/types";

export interface JuniorNitroOptions {
  cwd?: string;
  maxDuration?: number;
  pluginPackages?: string[];
}

/** Nitro module that copies app and plugin content into the Vercel build output. */
export function juniorNitro(options: JuniorNitroOptions = {}): {
  nitro: { setup(nitro: unknown): void };
} {
  return {
    nitro: {
      setup(nitro: Nitro) {
        const cwd = path.resolve(
          options.cwd ?? nitro.options.rootDir ?? process.cwd(),
        );

        nitro.options.vercel ??= {};
        nitro.options.vercel.functions ??= {};
        nitro.options.vercel.functions.maxDuration ??=
          options.maxDuration ?? 800;

        // Make plugin packages available to createApp() in dev mode
        // (in production, the compiled hook writes __junior_config.json).
        process.env.JUNIOR_PLUGIN_PACKAGES = JSON.stringify(
          options.pluginPackages ?? [],
        );

        nitro.hooks.hook("compiled", () => {
          copyAppAndPluginContent(
            cwd,
            nitro.options.output.serverDir,
            options.pluginPackages,
          );
          writeFileSync(
            path.join(nitro.options.output.serverDir, "__junior_config.json"),
            JSON.stringify({ pluginPackages: options.pluginPackages ?? [] }),
          );
        });
      },
    },
  };
}

function copyAppAndPluginContent(
  cwd: string,
  serverRoot: string,
  pluginPackages?: string[],
): void {
  copyIfExists(path.join(cwd, "app"), path.join(serverRoot, "app"));

  const packagedContent = discoverInstalledPluginPackageContent(cwd, {
    packageNames: pluginPackages,
  });
  for (const root of packagedContent.manifestRoots) {
    if (existsSync(path.join(root, "plugin.yaml"))) {
      const relative = path.relative(cwd, root);
      if (!relative || path.isAbsolute(relative) || relative.startsWith("..")) {
        continue;
      }
      copyIfExists(
        path.join(root, "plugin.yaml"),
        path.join(serverRoot, relative, "plugin.yaml"),
      );
      continue;
    }

    copyRootIntoServerOutput(cwd, serverRoot, root);
  }

  for (const root of packagedContent.skillRoots) {
    copyRootIntoServerOutput(cwd, serverRoot, root);
  }
}

function copyIfExists(source: string, target: string): void {
  if (!existsSync(source)) {
    return;
  }

  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function copyRootIntoServerOutput(
  cwd: string,
  serverRoot: string,
  root: string,
): void {
  const relative = path.relative(cwd, root);
  if (!relative || path.isAbsolute(relative) || relative.startsWith("..")) {
    return;
  }

  copyIfExists(root, path.join(serverRoot, relative));
}
