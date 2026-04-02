import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { discoverInstalledPluginPackageContent } from "@/chat/plugins/package-discovery";

export interface JuniorNitroConfigOptions {
  cwd?: string;
  maxDuration?: number;
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

/** Return the default Nitro config used by scaffolded Junior apps. */
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
