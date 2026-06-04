import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { Nitro } from "nitro/types";
import {
  COMPILED_APP_ROOT,
  COMPILED_NODE_MODULES_ROOT,
  type JuniorCompiledContent,
} from "@/chat/content";
import {
  discoverInstalledPluginPackageContent,
  type InstalledPluginPackageContent,
} from "@/chat/plugins/package-discovery";

function normalizeVirtualPath(targetPath: string): string {
  return path.posix.resolve(targetPath.replace(/\\/g, "/"));
}

function packageVirtualRoot(packageName: string): string {
  return `${COMPILED_NODE_MODULES_ROOT}/${packageName}`;
}

function toPosixRelative(base: string, targetPath: string): string {
  return path.relative(base, targetPath).split(path.sep).join("/");
}

function addFile(
  files: Record<string, string>,
  sourcePath: string,
  virtualPath: string,
): void {
  files[normalizeVirtualPath(virtualPath)] =
    readFileSync(sourcePath).toString("base64");
}

function addDirectory(
  files: Record<string, string>,
  sourceRoot: string,
  virtualRoot: string,
): void {
  if (!existsSync(sourceRoot)) {
    return;
  }

  const queue = [sourceRoot];
  const seenDirs = new Set<string>();
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const realDir = realpathSync(dir);
    if (seenDirs.has(realDir)) {
      continue;
    }
    seenDirs.add(realDir);

    for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const sourcePath = path.join(dir, entry.name);
      const stat = statSync(sourcePath);
      if (stat.isDirectory()) {
        queue.push(sourcePath);
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }

      const relativePath = toPosixRelative(sourceRoot, sourcePath);
      addFile(files, sourcePath, path.posix.join(virtualRoot, relativePath));
    }
  }
}

function packagePathMapper(
  packagedContent: InstalledPluginPackageContent,
): (sourcePath: string) => string {
  const packageRoots = packagedContent.packages
    .map((pkg) => ({
      sourceRoot: path.resolve(pkg.dir),
      virtualRoot: packageVirtualRoot(pkg.name),
    }))
    .sort((left, right) => right.sourceRoot.length - left.sourceRoot.length);

  return (sourcePath: string) => {
    const resolved = path.resolve(sourcePath);
    const pkg = packageRoots.find(
      (candidate) =>
        resolved === candidate.sourceRoot ||
        resolved.startsWith(`${candidate.sourceRoot}${path.sep}`),
    );
    if (!pkg) {
      throw new Error(
        `Configured plugin content is not inside a discovered package: ${sourcePath}`,
      );
    }

    return normalizeVirtualPath(
      path.posix.join(
        pkg.virtualRoot,
        toPosixRelative(pkg.sourceRoot, resolved),
      ),
    );
  };
}

function virtualizePackageContent(
  packagedContent: InstalledPluginPackageContent,
): InstalledPluginPackageContent {
  const mapPath = packagePathMapper(packagedContent);

  return {
    packageNames: [...packagedContent.packageNames],
    packages: packagedContent.packages.map((pkg) => ({
      name: pkg.name,
      hasSkillsDir: pkg.hasSkillsDir,
      dir: packageVirtualRoot(pkg.name),
    })),
    manifestRoots: packagedContent.manifestRoots.map(mapPath),
    skillRoots: packagedContent.skillRoots.map(mapPath),
    tracingIncludes: [...packagedContent.tracingIncludes],
  };
}

function addPackageContent(
  files: Record<string, string>,
  packagedContent: InstalledPluginPackageContent,
): void {
  const mapPath = packagePathMapper(packagedContent);

  for (const root of packagedContent.manifestRoots) {
    const manifestPath = path.join(root, "plugin.yaml");
    if (existsSync(manifestPath) && statSync(manifestPath).isFile()) {
      addFile(
        files,
        manifestPath,
        path.posix.join(mapPath(root), "plugin.yaml"),
      );
      continue;
    }

    addDirectory(files, root, mapPath(root));
  }

  for (const root of packagedContent.skillRoots) {
    addDirectory(files, root, mapPath(root));
  }
}

/** Build the private Junior content graph used by Nitro/serverless runtimes. */
export function buildCompiledContentGraph(
  cwd: string,
  packageNames?: unknown,
): JuniorCompiledContent {
  const files: Record<string, string> = {};
  const appRoot = path.join(cwd, "app");
  if (existsSync(appRoot)) {
    addDirectory(files, appRoot, COMPILED_APP_ROOT);
  }

  const packagedContent = discoverInstalledPluginPackageContent(cwd, {
    packageNames,
  });
  addPackageContent(files, packagedContent);
  const virtualPackageContent = virtualizePackageContent(packagedContent);

  return {
    version: 1,
    appRoot: COMPILED_APP_ROOT,
    files,
    skillRoots: [`${COMPILED_APP_ROOT}/skills`],
    packageContent: virtualPackageContent,
  };
}

/** Render the virtual module consumed by createApp() at runtime. */
export function renderCompiledContentModule(
  content: JuniorCompiledContent,
): string {
  return `export const content = ${JSON.stringify(content)};\n`;
}

/** Inject the private content graph virtual module for Nitro builds. */
export function injectVirtualContent(
  nitro: Nitro,
  options: {
    loadPackageNames?: () => Promise<unknown>;
    cwd: string;
  },
): void {
  nitro.options.virtual["#junior/content"] = async () => {
    const packageNames = await options.loadPackageNames?.();
    return renderCompiledContentModule(
      buildCompiledContentGraph(options.cwd, packageNames),
    );
  };
}
