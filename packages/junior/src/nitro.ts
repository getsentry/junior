import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { discoverInstalledPluginPackageContent } from "@/chat/plugins/package-discovery";
import type { Nitro } from "nitro/types";

/** @deprecated */
export interface JuniorNitroConfigOptions {
  cwd?: string;
  maxDuration?: number;
}

export interface JuniorNitroOptions {
  cwd?: string;
  maxDuration?: number;
}

export function juniorNitro(options: JuniorNitroOptions): {
  nitro: { setup(nitro: unknown): void };
} {
  return {
    nitro: {
      setup(nitro: Nitro) {
        const cwd = path.resolve(
          options.cwd ?? nitro.options.rootDir ?? process.cwd(),
        );

        // setup vercel maxDuration
        nitro.options.vercel ??= {};
        nitro.options.vercel.functions ??= {};
        nitro.options.vercel.functions.maxDuration ??=
          options.maxDuration ?? 800;

        // Copy app and plugin content on compiled hook
        nitro.hooks.hook("compiled", () => {
          copyAppAndPluginContent(cwd, nitro.options.output.serverDir);
        });
      },
    },
  };
}

function copyAppAndPluginContent(cwd: string, serverRoot: string): void {
  copyIfExists(path.join(cwd, "app"), path.join(serverRoot, "app"));

  const packagedContent = discoverInstalledPluginPackageContent(cwd);
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

/** @deprecated */
export function juniorNitroConfig(options: JuniorNitroConfigOptions = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());

  return {
    preset: "vercel" as const,
    vercel: {
      functions: {
        maxDuration: options.maxDuration ?? 800,
      },
    },
    modules: [
      {
        setup(nitro: {
          hooks: { hook(name: "compiled", callback: () => void): void };
          options: { output: { serverDir: string } };
        }) {
          nitro.hooks.hook("compiled", () => {
            copyAppAndPluginContent(cwd, nitro.options.output.serverDir);
          });
        },
      },
    ],
  };
}
