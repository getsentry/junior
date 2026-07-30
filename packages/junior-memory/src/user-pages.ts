/** Project viewer-owned memories into Junior's core-rendered user page. */
import type { PluginUserPageDefinition } from "@sentry/junior-plugin-api";
import { createViewerMemories } from "./personal";
import type { MemoryDb, MemoryRecord } from "./store";

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function rememberedDate(createdAtMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(createdAtMs));
}

function subjectLabel(memory: MemoryRecord): string {
  return titleCase(memory.subjectType);
}

/** Create the interactive personal Memories dashboard page. */
export function createMemoryUserPage(): PluginUserPageDefinition {
  return {
    id: "memories",
    label: "Memories",
    navigation: "primary",
    description: "Personal facts and preferences Junior remembers about you.",
    async read(ctx, input) {
      const memories = createViewerMemories(
        ctx.db as MemoryDb,
        ctx.viewer.actors,
      );
      const page = await memories.list({
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
            { label: "Type", value: titleCase(memory.kind) },
            { label: "Scope", value: titleCase(memory.scope) },
            { label: "Subject", value: subjectLabel(memory) },
            { label: "Remembered", value: rememberedDate(memory.createdAtMs) },
            { label: "Observed", value: rememberedDate(memory.observedAtMs) },
            {
              label: "Expires",
              value: memory.expiresAtMs
                ? rememberedDate(memory.expiresAtMs)
                : "Never",
            },
            { label: "Memory ID", value: memory.id },
          ],
        })),
      };
    },
  };
}
