import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
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
          copyIncludedFiles(
            cwd,
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

/**
 * Resolve a package subpath pattern like `@scope/pkg/dist/dir/*.js`
 * and copy matching files into the server output under `node_modules/`.
 */
/** Resolve a package to its root directory using import.meta.resolve. */
function resolvePackageDir(pkgName: string): string | undefined {
  try {
    // Resolve an exported subpath to locate the package on disk.
    const resolved = import.meta.resolve(pkgName);
    const entry = resolved.startsWith("file://")
      ? fileURLToPath(resolved)
      : resolved;
    // Walk up to the directory whose name matches the package's last segment.
    const lastSeg = pkgName.split("/").pop()!;
    let dir = path.dirname(entry);
    while (dir !== path.dirname(dir)) {
      if (path.basename(dir) === lastSeg) return dir;
      dir = path.dirname(dir);
    }
  } catch {
    // Package not resolvable from this module
  }
  return undefined;
}

function copyIncludedFiles(
  _cwd: string,
  serverRoot: string,
  patterns?: string[],
): void {
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
      ? new RegExp(`^${fileGlob.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`)
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
