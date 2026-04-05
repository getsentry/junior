import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverInstalledPluginPackageContent } from "@/chat/plugins/package-discovery";
import type { Nitro } from "nitro/types";

export interface JuniorNitroOptions {
  cwd?: string;
  maxDuration?: number;
  pluginPackages?: string[];
  /**
   * Extra file patterns to copy into the server output for files that the
   * bundler cannot trace (e.g. dynamically imported providers).
   * Each entry is `"<package-name>/<subpath-glob>"`, resolved via Node
   * module resolution. Example: `"@mariozechner/pi-ai/dist/providers/*.js"`
   */
  includeFiles?: string[];
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

        // pi-ai registers API providers via a top-level side-effect in
        // register-builtins.js. Nitro's default moduleSideEffects whitelist
        // only includes unenv polyfills, so rolldown tree-shakes the
        // registration call and the apiProviderRegistry Map stays empty at
        // runtime. Override rolldown's treeshake config so that pi-ai
        // side effects survive bundling.
        nitro.options.rolldownConfig = {
          ...nitro.options.rolldownConfig,
          treeshake: {
            moduleSideEffects: true,
          },
        };

        // Virtual module so createApp() can read the plugin list at runtime.
        nitro.options.virtual["#junior/config"] =
          `export const pluginPackages = ${JSON.stringify(options.pluginPackages ?? [])};`;

        nitro.hooks.hook("compiled", () => {
          copyAppAndPluginContent(
            cwd,
            nitro.options.output.serverDir,
            options.pluginPackages,
          );
          copyIncludedFiles(
            nitro.options.output.serverDir,
            options.includeFiles,
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

/** Resolve a package to its root directory using import.meta.resolve. */
function resolvePackageDir(pkgName: string): string | undefined {
  try {
    const resolved = import.meta.resolve(pkgName);
    const entry = resolved.startsWith("file://")
      ? fileURLToPath(resolved)
      : resolved;
    // Walk up from the resolved entry to find the package root (contains package.json).
    let dir = path.dirname(entry);
    while (dir !== path.dirname(dir)) {
      if (existsSync(path.join(dir, "package.json"))) return dir;
      dir = path.dirname(dir);
    }
  } catch {
    // Package not resolvable from this module
  }
  return undefined;
}

function copyIncludedFiles(serverRoot: string, patterns?: string[]): void {
  if (!patterns?.length) return;
  for (const pattern of patterns) {
    const normalized = pattern.replace(/^node_modules\//, "");
    const parts = normalized.split("/");
    const pkgName = parts[0].startsWith("@")
      ? `${parts[0]}/${parts[1]}`
      : parts[0];
    const subpath = parts.slice(pkgName.includes("/") ? 2 : 1).join("/");
    const fileGlob = path.basename(subpath);
    const subDir = path.dirname(subpath);

    const pkgDir = resolvePackageDir(pkgName);
    if (!pkgDir) continue;

    const sourceDir = path.join(pkgDir, subDir);
    if (!existsSync(sourceDir)) continue;

    const entries = readdirSync(sourceDir);
    const re = fileGlob.includes("*")
      ? new RegExp(
          `^${fileGlob.replace(/[\\^$+?.()|[\]{}]/g, "\\$&").replace(/\*/g, ".*")}$`,
        )
      : null;

    for (const entry of entries) {
      if (re ? !re.test(entry) : entry !== fileGlob) continue;
      copyIfExists(
        path.join(sourceDir, entry),
        path.join(serverRoot, "node_modules", pkgName, subDir, entry),
      );
    }
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
