import { statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JuniorPluginSet } from "./plugins";

interface JuniorPluginModuleReference {
  /** Runtime-safe module that exports a `defineJuniorPlugins(...)` set. */
  module: string;
  /** Named export to import from `module`. Defaults to `plugins`. */
  exportName?: string;
}

interface ResolvedPluginModuleReference {
  exportName: string;
  importPath: string;
  importUrl: string;
  kind: "file" | "package";
  sourceSpecifier: string;
}

const PLUGIN_MODULE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".mjs",
  ".js",
  ".cjs",
];

/** Resolve a relative plugin module path using Junior's supported extension order. */
function resolveRelativePluginModule(cwd: string, specifier: string): string {
  const basePath = path.resolve(cwd, specifier);
  for (const extension of PLUGIN_MODULE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next extension.
    }
  }
  for (const extension of PLUGIN_MODULE_EXTENSIONS) {
    const candidate = path.join(basePath, `index${extension}`);
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next extension.
    }
  }

  throw new Error(`Plugin module "${specifier}" could not be resolved`);
}

/** Resolve the runtime-safe plugin module used by Junior app wiring. */
export function resolvePluginModule(
  cwd: string,
  input: JuniorPluginModuleReference | string,
): ResolvedPluginModuleReference {
  const moduleSpecifier = typeof input === "string" ? input : input.module;
  const exportName =
    typeof input === "string" ? "plugins" : (input.exportName ?? "plugins");
  if (!moduleSpecifier.trim()) {
    throw new Error("Plugin module specifier must not be empty");
  }

  if (moduleSpecifier.startsWith(".") || path.isAbsolute(moduleSpecifier)) {
    const resolvedPath = resolveRelativePluginModule(cwd, moduleSpecifier);
    return {
      exportName,
      importPath: resolvedPath,
      importUrl: pathToFileURL(resolvedPath).href,
      kind: "file",
      sourceSpecifier: moduleSpecifier,
    };
  }

  const requireFromApp = createRequire(path.join(cwd, "package.json"));
  const resolvedPath = requireFromApp.resolve(moduleSpecifier);
  return {
    exportName,
    importPath: resolvedPath,
    importUrl: pathToFileURL(resolvedPath).href,
    kind: "package",
    sourceSpecifier: moduleSpecifier,
  };
}

/** Assert that a module export is a Junior plugin set. */
function assertPluginSet(value: unknown, source: string): JuniorPluginSet {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as Partial<JuniorPluginSet>).packageNames) ||
    !Array.isArray((value as Partial<JuniorPluginSet>).registrations)
  ) {
    throw new Error(
      `Plugin module ${source} must export a defineJuniorPlugins(...) set`,
    );
  }

  const pluginSet = value as Partial<JuniorPluginSet>;
  const invalidPackageName = pluginSet.packageNames?.find(
    (packageName) => typeof packageName !== "string",
  );
  if (invalidPackageName !== undefined) {
    throw new Error(`Plugin module ${source} must export string package names`);
  }

  const invalidRegistration = pluginSet.registrations?.find(
    (registration) =>
      !registration ||
      typeof registration !== "object" ||
      !("manifest" in registration) ||
      !registration.manifest ||
      typeof registration.manifest !== "object" ||
      !("name" in registration.manifest) ||
      typeof registration.manifest.name !== "string",
  );
  if (invalidRegistration) {
    throw new Error(
      `Plugin module ${source} must export plugin registrations with manifest names`,
    );
  }

  return value as JuniorPluginSet;
}

/** Load a resolved plugin module and return its configured plugin set. */
export async function loadPluginSetFromModule(
  moduleRef: ResolvedPluginModuleReference,
  importModule: (
    moduleRef: ResolvedPluginModuleReference,
  ) => Promise<Record<string, unknown>> = async (ref) =>
    (await import(ref.importUrl)) as Record<string, unknown>,
): Promise<JuniorPluginSet> {
  const mod = await importModule(moduleRef);
  const value =
    moduleRef.exportName === "default"
      ? (mod.default as unknown)
      : mod[moduleRef.exportName];
  return assertPluginSet(
    value,
    `${moduleRef.importUrl}#${moduleRef.exportName}`,
  );
}

/** Load an app-local `./plugins` module when one exists. */
export async function loadAppPluginSet(
  cwd: string,
  importModule?: (
    moduleRef: ResolvedPluginModuleReference,
  ) => Promise<Record<string, unknown>>,
): Promise<JuniorPluginSet | undefined> {
  let pluginModule: ResolvedPluginModuleReference;
  try {
    pluginModule = resolvePluginModule(cwd, "./plugins");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Plugin module "./plugins" could not be resolved'
    ) {
      return undefined;
    }
    throw error;
  }

  return await loadPluginSetFromModule(pluginModule, importModule);
}
