import { resolveRuntimeDependencySnapshot, type RuntimeDependencySnapshotProgressPhase } from "@/chat/sandbox/runtime-dependency-snapshots";
import { disconnectStateAdapter } from "@/chat/state";

const DEFAULT_RUNTIME = "node22";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function progressMessage(phase: RuntimeDependencySnapshotProgressPhase): string {
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

export async function runSnapshotCreate(log: (line: string) => void = console.log): Promise<void> {
  const runtime = DEFAULT_RUNTIME;
  const timeoutMs = DEFAULT_TIMEOUT_MS;

  try {
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
      }
    });

    const fields = [
      `runtime=${runtime}`,
      `resolve_outcome=${snapshot.resolveOutcome}`,
      `cache_hit=${snapshot.cacheHit}`,
      `dependency_count=${snapshot.dependencyCount}`,
      ...(snapshot.profileHash ? [`profile_hash=${snapshot.profileHash}`] : []),
      ...(snapshot.snapshotId ? [`snapshot_id=${snapshot.snapshotId}`] : []),
      ...(snapshot.rebuildReason ? [`rebuild_reason=${snapshot.rebuildReason}`] : [])
    ];
    log(`Sandbox snapshot create complete: ${fields.join(" ")}`);
  } finally {
    await disconnectStateAdapter();
  }
}
