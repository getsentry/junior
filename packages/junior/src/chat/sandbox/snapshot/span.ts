import { setSpanAttributes, withSpan } from "@/chat/logging";
import type { Snapshot } from "@/chat/sandbox/snapshot/resolve";

/** Record the reusable snapshot selected for a new Sandbox. */
export function setSnapshotSpanAttributes(snapshot: Snapshot): void {
  setSpanAttributes({
    "app.sandbox.source": snapshot.snapshotId ? "snapshot" : "created",
    "app.sandbox.snapshot.cache_hit": snapshot.cacheHit,
    "app.sandbox.snapshot.resolve_outcome": snapshot.resolveOutcome,
    ...(snapshot.profileHash
      ? { "app.sandbox.snapshot.profile_hash": snapshot.profileHash }
      : {}),
    "app.sandbox.snapshot.dependency_count": snapshot.dependencyCount,
    ...(snapshot.rebuildReason
      ? { "app.sandbox.snapshot.rebuild_reason": snapshot.rebuildReason }
      : {}),
  });
}

/** Record one stage of dependency snapshot resolution or creation. */
export async function trace<T>(
  name: string,
  op: string,
  attributes: Record<string, unknown>,
  callback: () => Promise<T>,
): Promise<T> {
  return await withSpan(name, op, {}, callback, attributes);
}
