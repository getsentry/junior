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
      const [page, stats] = await Promise.all([
        memories.list({
          cursor: input.cursor,
          limit: input.limit,
          ...(input.query ? { query: input.query } : {}),
        }),
        memories.stats(),
      ]);
      const embeddingCoverage =
        stats.active === 0 ? 0 : stats.embedded / stats.active;
      return {
        type: "list",
        emptyText: input.query
          ? "No memories matched your search."
          : "No personal memories yet.",
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        metrics: [
          {
            detail: `${stats.createdThirtyDays} added in the last 30 days`,
            label: "Active memories",
            tone: stats.active > 0 ? ("good" as const) : ("neutral" as const),
            value: stats.active.toLocaleString("en-US"),
          },
          {
            detail: "How Junior adapts to you",
            label: "Preferences",
            value: stats.preference.toLocaleString("en-US"),
          },
          {
            detail: `${stats.procedure.toLocaleString("en-US")} procedures`,
            label: "Knowledge",
            value: stats.knowledge.toLocaleString("en-US"),
          },
          {
            detail: `${stats.embedded.toLocaleString("en-US")} of ${stats.active.toLocaleString("en-US")} searchable by meaning`,
            label: "Search ready",
            tone:
              stats.active === 0
                ? ("neutral" as const)
                : stats.embedded === stats.active
                  ? ("good" as const)
                  : ("warning" as const),
            value: new Intl.NumberFormat("en-US", {
              maximumFractionDigits: 0,
              style: "percent",
            }).format(embeddingCoverage),
          },
        ],
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
