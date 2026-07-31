/** Project viewer-owned memories into Junior's core-rendered user page. */
import type { PluginUserPageDefinition } from "@sentry/junior-plugin-api";
import { createViewerMemories } from "./personal";
import type { PersonalMemoryRecord } from "./personal-store";
import type { MemoryDb } from "./store";

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

function originLabel(origin: PersonalMemoryRecord["origin"]): string {
  if (origin === "automatic") return "Automatic";
  if (origin === "explicit") return "Explicit";
  return "Other";
}

function pageFilter(filter: string | undefined): {
  kind?: "preference";
  origin?: "automatic" | "explicit";
} {
  if (filter === "preferences") return { kind: "preference" };
  if (filter === "automatic") return { origin: "automatic" };
  if (filter === "explicit") return { origin: "explicit" };
  return {};
}

function pageEmptyText(input: { filter?: string; query?: string }): string {
  if (input.query) return "No memories matched your search.";
  if (input.filter === "preferences") return "No preferences yet.";
  if (input.filter === "automatic") return "No learned memories yet.";
  if (input.filter === "explicit") return "No saved memories yet.";
  return "No personal memories yet.";
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
        ...pageFilter(input.filter),
        limit: input.limit,
        ...(input.query ? { query: input.query } : {}),
      });
      return {
        type: "list",
        emptyText: pageEmptyText(input),
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
            { label: "Learned", value: originLabel(memory.origin) },
            { label: "Source", value: titleCase(memory.sourcePlatform) },
            { label: "Visibility", value: "Only you" },
            { label: "Remembered", value: rememberedDate(memory.createdAtMs) },
            { label: "Observed", value: rememberedDate(memory.observedAtMs) },
            {
              label: "Expires",
              value: memory.expiresAtMs
                ? rememberedDate(memory.expiresAtMs)
                : "Never",
            },
          ],
        })),
      };
    },
  };
}
