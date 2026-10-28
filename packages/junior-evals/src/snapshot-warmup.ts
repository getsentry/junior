import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { runSnapshotCreate } from "@/cli/snapshot-create";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import * as profile from "@/chat/sandbox/snapshot/profile";
import {
  getCachedSnapshot,
  setCachedSnapshot,
  type CachedSnapshot,
} from "@/chat/sandbox/snapshot/resolve";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import {
  defineJuniorPlugins,
  pluginCatalogConfigFromPluginSet,
} from "@/plugins";
import { evalRuntimePlugins } from "./eval-plugin-fixtures";

// Each eval run has new state, so the product does not know the snapshots of
// earlier runs. This file keeps them for all checkouts of a machine.
const SAVED_SNAPSHOTS_FILE = path.join(
  homedir(),
  ".cache/junior-evals/sandbox-snapshots.json",
);
// Vercel deletes a snapshot after 30 days.
const MAX_SAVED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Warm one plugin dependency profile and restore the eval catalog afterward.
 * A snapshot that an earlier run built is used again.
 */
export async function warmSandboxSnapshot(
  pluginPackages: readonly string[] = [],
): Promise<void> {
  const previousCatalogConfig = pluginCatalogRuntime.setConfig(
    pluginCatalogConfigFromPluginSet(
      defineJuniorPlugins([
        ...pluginPackages,
        ...evalRuntimePlugins(pluginPackages),
      ]),
    ),
  );
  try {
    // Every profile has the global runtime dependencies, so it has a hash.
    const profileHash = profile.hash(SANDBOX_RUNTIME)!;
    const saved: Record<string, CachedSnapshot> = existsSync(
      SAVED_SNAPSHOTS_FILE,
    )
      ? JSON.parse(readFileSync(SAVED_SNAPSHOTS_FILE, "utf8"))
      : {};
    const snapshot = saved[profileHash];
    if (snapshot && Date.now() - snapshot.createdAtMs < MAX_SAVED_AGE_MS) {
      await setCachedSnapshot(snapshot);
    }
    await runSnapshotCreate();
    const current = await getCachedSnapshot(profileHash);
    if (current && current.snapshotId !== snapshot?.snapshotId) {
      mkdirSync(path.dirname(SAVED_SNAPSHOTS_FILE), { recursive: true });
      writeFileSync(
        SAVED_SNAPSHOTS_FILE,
        JSON.stringify({ ...saved, [profileHash]: current }, null, 2),
      );
    }
  } finally {
    pluginCatalogRuntime.setConfig(previousCatalogConfig);
  }
}
