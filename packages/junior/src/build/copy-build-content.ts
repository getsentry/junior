import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { discoverInstalledPluginPackageContent } from "@/chat/plugins/package-discovery";
import { globToRegex } from "@/build/glob-to-regex";
import { resolvePackageDir } from "@/build/resolve-package";

/** Copy app directory and plugin manifests into the server output. */
export function copyAppAndPluginContent(
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

/** Copy extra file patterns into server output for files the bundler cannot trace. */
export function copyIncludedFiles(
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
    const re = fileGlob.includes("*") ? globToRegex(fileGlob) : null;

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
