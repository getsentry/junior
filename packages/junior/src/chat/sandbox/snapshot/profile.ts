import { createHash } from "node:crypto";
import type { Workspace } from "@/chat/workspaces/types";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import type {
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
} from "@/chat/plugins/types";
import {
  GLOBAL_RUNTIME_DEPENDENCIES,
  GLOBAL_RUNTIME_POSTINSTALL,
} from "@/chat/sandbox/runtime-dependencies";

const VERSION = 1;
const DEFAULT_FLOATING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type Profile = {
  hash: string;
  dependencyCount: number;
  floating: boolean;
  dependencies: PluginRuntimeDependency[];
  postinstall: PluginRuntimePostinstallCommand[];
  /**
   * When set, this profile extends a base dependency snapshot instead of
   * installing dependencies itself. The hash includes the base hash so base
   * busts also bust workspace snapshots.
   */
  baseHash?: string;
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

function workspaceRecipe(workspace: Workspace) {
  // Sort repos so profile hashes stay stable when query order differs.
  const repos = [...workspace.repos].sort((left, right) => {
    const provider = left.provider.localeCompare(right.provider);
    if (provider !== 0) return provider;
    const repo = left.repo.localeCompare(right.repo);
    if (repo !== 0) return repo;
    return left.checkoutPath.localeCompare(right.checkoutPath);
  });
  return {
    id: workspace.id,
    updatedAt: workspace.updatedAt.toISOString(),
    repos,
    setupScript: workspace.setupScript,
  };
}

/** Build the base dependency profile without workspace contents. */
function createBase(runtime: string): Profile | null {
  const dependencies = mergeDependencies([
    ...GLOBAL_RUNTIME_DEPENDENCIES,
    ...pluginCatalogRuntime.getRuntimeDependencies(),
  ]);
  const pluginPostinstall = pluginCatalogRuntime.getRuntimePostinstall();
  const postinstall = [...GLOBAL_RUNTIME_POSTINSTALL, ...pluginPostinstall];
  if (dependencies.length === 0 && postinstall.length === 0) {
    return null;
  }

  const rebuildEpoch = process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH?.trim() ?? "";
  // Plugin postinstall commands may fetch mutable artifacts, so profiles
  // containing them expire on the same schedule as floating npm selectors.
  const floating =
    dependencies.some((dependency) => isFloating(dependency)) ||
    pluginPostinstall.length > 0;
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

/**
 * Build the dependency profile that selects a reusable sandbox snapshot.
 *
 * Workspace profiles extend the base dependency profile: their hash includes
 * the base hash plus the workspace recipe, and build boots from the base
 * snapshot instead of reinstalling dependencies.
 */
export function create(runtime: string, workspace?: Workspace): Profile | null {
  const base = createBase(runtime);
  if (!workspace) {
    return base;
  }

  const rebuildEpoch = process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH?.trim() ?? "";
  const baseHash = base?.hash;
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        version: VERSION,
        kind: "workspace",
        runtime,
        rebuildEpoch,
        baseHash: baseHash ?? null,
        workspace: workspaceRecipe(workspace),
      }),
    )
    .digest("hex");

  return {
    hash,
    // Preserve base dependency count for telemetry; install work is skipped.
    dependencyCount: base?.dependencyCount ?? 0,
    floating: true,
    dependencies: [],
    postinstall: [],
    ...(baseHash ? { baseHash } : {}),
  };
}

/** Return the current dependency profile hash without building its snapshot. */
export function hash(runtime: string, workspace?: Workspace): string | undefined {
  return create(runtime, workspace)?.hash;
}

/** Decide whether a cached snapshot has outlived a floating profile. */
export function isStale(profile: Profile, createdAtMs: number): boolean {
  if (!profile.floating) {
    return false;
  }
  const maxAgeMs = floatingMaxAgeMs();
  return maxAgeMs === 0 || Date.now() - createdAtMs > maxAgeMs;
}
