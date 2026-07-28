import { createHash } from "node:crypto";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import type {
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
} from "@/chat/plugins/types";
import { GLOBAL_RUNTIME_DEPENDENCIES } from "@/chat/sandbox/runtime-dependencies";

const VERSION = 1;
const DEFAULT_FLOATING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type Profile = {
  hash: string;
  dependencyCount: number;
  floating: boolean;
  dependencies: PluginRuntimeDependency[];
  postinstall: PluginRuntimePostinstallCommand[];
};

function isExactNpmVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][a-z0-9.]+)?$/i.test(version.trim());
}

function isFloating(dep: PluginRuntimeDependency): boolean {
  return dep.type === "npm" && !isExactNpmVersion(dep.version);
}

/**
 * Merge dependencies for one global install, rejecting competing npm versions.
 */
function mergeDependencies(
  dependencies: PluginRuntimeDependency[],
): PluginRuntimeDependency[] {
  const seen = new Set<string>();
  const npmVersions = new Map<string, string>();
  const merged: PluginRuntimeDependency[] = [];

  for (const dependency of dependencies) {
    const key =
      dependency.type === "npm"
        ? `${dependency.type}:${dependency.package}:${dependency.version}`
        : "package" in dependency
          ? `${dependency.type}:package:${dependency.package}`
          : `${dependency.type}:url:${dependency.url}:${dependency.sha256}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (dependency.type === "npm") {
      const version = npmVersions.get(dependency.package);
      if (version !== undefined && version !== dependency.version) {
        throw new Error(
          `Conflicting runtime dependency versions for ${dependency.package}: ${version} and ${dependency.version}`,
        );
      }
      npmVersions.set(dependency.package, dependency.version);
    }

    merged.push(dependency);
  }

  return merged;
}

function floatingMaxAgeMs(): number {
  const raw = process.env.SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS;
  if (!raw?.trim()) {
    return DEFAULT_FLOATING_MAX_AGE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_FLOATING_MAX_AGE_MS;
}

/** Build the dependency profile that selects a reusable sandbox snapshot. */
export function create(runtime: string): Profile | null {
  const dependencies = mergeDependencies([
    ...GLOBAL_RUNTIME_DEPENDENCIES,
    ...pluginCatalogRuntime.getRuntimeDependencies(),
  ]);
  const postinstall = pluginCatalogRuntime.getRuntimePostinstall();
  if (dependencies.length === 0 && postinstall.length === 0) {
    return null;
  }

  const rebuildEpoch = process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH?.trim() ?? "";
  // Postinstall commands may fetch mutable artifacts, so profiles containing
  // them expire on the same schedule as floating npm selectors.
  const floating =
    dependencies.some((dependency) => isFloating(dependency)) ||
    postinstall.length > 0;
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        version: VERSION,
        runtime,
        rebuildEpoch,
        dependencies,
        postinstall,
      }),
    )
    .digest("hex");

  return {
    hash,
    dependencyCount: dependencies.length,
    floating,
    dependencies,
    postinstall,
  };
}

/** Return the current dependency profile hash without building its snapshot. */
export function hash(runtime: string): string | undefined {
  return create(runtime)?.hash;
}

/** Decide whether a cached snapshot has outlived a floating profile. */
export function isStale(profile: Profile, createdAtMs: number): boolean {
  if (!profile.floating) {
    return false;
  }
  const maxAgeMs = floatingMaxAgeMs();
  return maxAgeMs === 0 || Date.now() - createdAtMs > maxAgeMs;
}
