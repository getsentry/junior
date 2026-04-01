import {
  getPluginProviders,
  getPluginRuntimeDependencies,
  getPluginRuntimePostinstall,
} from "@/chat/plugins/registry";
import {
  resolveRuntimeDependencySnapshot,
  type RuntimeDependencySnapshotProgressPhase,
} from "@/chat/sandbox/runtime-dependency-snapshots";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { writeVercelJson } from "@/vercel";

const DEFAULT_RUNTIME = "node22";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function progressMessage(
  phase: RuntimeDependencySnapshotProgressPhase,
): string {
  if (phase === "resolve_start") {
    return "Resolving sandbox snapshot profile...";
  }
  if (phase === "cache_hit") {
    return "Using cached sandbox snapshot.";
  }
  if (phase === "waiting_for_lock") {
    return "Waiting for sandbox snapshot build lock...";
  }
  if (phase === "building_snapshot") {
    return "Building sandbox snapshot...";
  }
  return "Sandbox snapshot build complete.";
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function logSnapshotProfile(log: (line: string) => void): void {
  const providers = getPluginProviders();
  const pluginNames = providers.map((plugin) => plugin.manifest.name).sort();
  const snapshotPluginNames = providers
    .filter(
      (plugin) =>
        (plugin.manifest.runtimeDependencies?.length ?? 0) > 0 ||
        (plugin.manifest.runtimePostinstall?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.manifest.name)
    .sort();
  const systemDependencies: string[] = [];
  const npmDependencies: string[] = [];
  for (const dep of getPluginRuntimeDependencies()) {
    if (dep.type === "npm") {
      npmDependencies.push(`${dep.package}@${dep.version}`);
      continue;
    }

    systemDependencies.push("package" in dep ? dep.package : dep.url);
  }
  const postinstallCommands = getPluginRuntimePostinstall().map(
    ({ cmd, args }) =>
      [cmd, ...(args ?? [])].filter((part) => part.trim().length > 0).join(" "),
  );

  log(`Loaded plugins (${pluginNames.length}): ${formatList(pluginNames)}`);
  log(
    "Sandbox snapshot inputs: " +
      [
        `plugins=${snapshotPluginNames.length}`,
        `system_dependencies=${systemDependencies.length}`,
        `npm_dependencies=${npmDependencies.length}`,
        `postinstall_commands=${postinstallCommands.length}`,
      ].join(" "),
  );

  if (
    snapshotPluginNames.length === 0 &&
    systemDependencies.length === 0 &&
    npmDependencies.length === 0 &&
    postinstallCommands.length === 0
  ) {
    return;
  }

  log(
    `Snapshot plugins (${snapshotPluginNames.length}): ${formatList(snapshotPluginNames)}`,
  );

  if (systemDependencies.length > 0) {
    log(
      `System dependencies (${systemDependencies.length}): ${systemDependencies.join(", ")}`,
    );
  }

  if (npmDependencies.length > 0) {
    log(
      `NPM dependencies (${npmDependencies.length}): ${npmDependencies.join(", ")}`,
    );
  }

  if (postinstallCommands.length > 0) {
    log(
      `Runtime postinstall (${postinstallCommands.length}): ${postinstallCommands.join(", ")}`,
    );
  }
}

export async function runSnapshotCreate(
  log: (line: string) => void = console.log,
): Promise<void> {
  if (process.env.JUNIOR_SKIP_SNAPSHOT === "1") {
    log("Skipping sandbox snapshot create (JUNIOR_SKIP_SNAPSHOT=1)");
    return;
  }

  const runtime = DEFAULT_RUNTIME;
  const timeoutMs = DEFAULT_TIMEOUT_MS;

  const vercelJsonPath = writeVercelJson();
  log(`Wrote ${vercelJsonPath}`);

  try {
    logSnapshotProfile(log);
    const emitted = new Set<RuntimeDependencySnapshotProgressPhase>();
    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime,
      timeoutMs,
      onProgress: async (phase) => {
        if (emitted.has(phase)) {
          return;
        }
        emitted.add(phase);
        log(progressMessage(phase));
      },
    });

    const fields = [
      `runtime=${runtime}`,
      `resolve_outcome=${snapshot.resolveOutcome}`,
      `cache_hit=${snapshot.cacheHit}`,
      `dependency_count=${snapshot.dependencyCount}`,
      ...(snapshot.profileHash ? [`profile_hash=${snapshot.profileHash}`] : []),
      ...(snapshot.snapshotId ? [`snapshot_id=${snapshot.snapshotId}`] : []),
      ...(snapshot.rebuildReason
        ? [`rebuild_reason=${snapshot.rebuildReason}`]
        : []),
    ];
    log(`Sandbox snapshot create complete: ${fields.join(" ")}`);
  } finally {
    await disconnectStateAdapter();
  }
}
