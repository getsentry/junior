/** Project viewer-owned memories into Junior's core-rendered user page. */
import type { PluginUserPageDefinition } from "@sentry/junior-plugin-api";
import { createViewerMemories } from "./personal";
import type { MemoryDb, MemoryRecord } from "./store";

function memoryKindLabel(kind: MemoryRecord["kind"]): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function rememberedDate(createdAtMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(createdAtMs));
}

/** Create the interactive personal Memories dashboard page. */
export function createMemoryUserPage(): PluginUserPageDefinition {
  return {
    id: "memories",
    label: "Memories",
    description: "Personal facts and preferences Junior remembers about you.",
    async read(ctx, input) {
      const page = await createViewerMemories(
        ctx.db as MemoryDb,
        ctx.viewer.actors,
      ).list({
        cursor: input.cursor,
        limit: input.limit,
        ...(input.query ? { query: input.query } : {}),
      });
      return {
        type: "list",
        emptyText: input.query
          ? "No memories matched your search."
          : "No personal memories yet.",
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        searchPlaceholder: "Search memories",
        records: page.memories.map((memory) => ({
          actions: [
            {
              confirmation: "Forget this memory?",
              href: `/api/plugins/memory/memories/${encodeURIComponent(memory.id)}`,
              label: "Forget",
              method: "DELETE" as const,
              tone: "danger" as const,
            },
          ],
          id: memory.id,
          title: memory.content,
          metadata: [
            { label: "Type", value: memoryKindLabel(memory.kind) },
            { label: "Remembered", value: rememberedDate(memory.createdAtMs) },
          ],
        })),
      };
    },
  };
}
