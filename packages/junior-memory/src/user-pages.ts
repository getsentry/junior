/** Project viewer-visible memories into Junior's core-rendered user page. */
import type { PluginUserPageDefinition } from "@sentry/junior-plugin-api";
import { createViewerMemories } from "./viewer";
import type { ViewerMemory } from "./viewer-store";
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

function originLabel(origin: ViewerMemory["origin"]): string {
  if (origin === "automatic") return "Automatic";
  if (origin === "explicit") return "Explicit";
  return "Other";
}

function pageEmptyText(input: { query?: string }): string {
  if (input.query) return "No memories matched your search.";
  return "No memories yet.";
}

/** Create the interactive Memories dashboard page. */
export function createMemoryUserPage(): PluginUserPageDefinition {
  return {
    id: "memories",
    label: "Memories",
    navigation: "primary",
    description: "Public memories Junior can use across conversations.",
    async read(ctx, input) {
      const memories = createViewerMemories(ctx.db as MemoryDb);
      const page = await memories.list({
        cursor: input.cursor,
        limit: input.limit,
        ...(input.query ? { query: input.query } : undefined),
      });
      return {
        type: "list",
        emptyText: pageEmptyText(input),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : undefined),
        searchPlaceholder: "Search memories",
        records: page.memories.map((memory) => ({
          id: memory.id,
          title: memory.content,
          metadata: [
            { label: "Type", value: titleCase(memory.kind) },
            { label: "Learned", value: originLabel(memory.origin) },
            { label: "Source", value: titleCase(memory.sourcePlatform) },
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
