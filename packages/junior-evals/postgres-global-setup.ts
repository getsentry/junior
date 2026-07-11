import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { setupJuniorPostgresHarness } from "@junior-tests/fixtures/postgres/global-setup";
import { migratePluginSchemas } from "@/chat/plugins/migrations";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  return await setupJuniorPostgresHarness(project, {
    migrateTemplate: async (executor) => {
      await migratePluginSchemas(executor, [
        {
          dir: path.resolve(workspaceRoot, "packages/junior-memory/migrations"),
          pluginName: "memory",
        },
        {
          dir: path.resolve(
            workspaceRoot,
            "packages/junior-scheduler/migrations",
          ),
          pluginName: "scheduler",
        },
      ]);
    },
  });
}
