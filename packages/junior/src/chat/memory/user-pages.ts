/** Render memory in Junior's User page format. */
import type { PluginUserPageDefinition } from "@sentry/junior-plugin-api";
import { listMemories, type MemoryView } from "./viewer";
import { memoryDb } from "./store";

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

function originLabel(origin: MemoryView["origin"]): string {
  if (origin === "automatic") return "Automatic";
  if (origin === "explicit") return "Explicit";
  return "Other";
}

/** The page filter that lists archived memories instead of active ones. */
const ARCHIVED_MEMORY_FILTER = "archived";

// Why a memory left recall, by `archive_reason`.
const ARCHIVE_REASON_LABELS: Record<string, string> = {
  contradicted: "Contradicted",
  superseded: "Replaced",
  tool_removed: "Forgotten",
  user_removed: "Forgotten",
};

function pageEmptyText(input: {
  archived: boolean;
  query?: string | undefined;
}): string {
  if (input.query) return "No memories matched your search.";
  if (input.archived) return "No archived memories.";
  return "No memories yet.";
}

function archiveFacts(memory: MemoryView) {
  if (memory.archivedAtMs === undefined) return [];
  return [
    { label: "Archived", value: rememberedDate(memory.archivedAtMs) },
    {
      label: "Reason",
      value: ARCHIVE_REASON_LABELS[memory.archiveReason ?? ""] ?? "Archived",
    },
  ];
}

/** Create the interactive Memories dashboard page. */
export function createMemoryUserPage(): PluginUserPageDefinition {
  return {
    id: "memories",
    label: "Memories",
    navigation: "profile",
    description: "Public memories that every conversation can use.",
    async read(ctx, input) {
      const archived = input.filter === ARCHIVED_MEMORY_FILTER;
      const page = await listMemories(memoryDb(ctx.db), {
        ...(archived ? { archived: true } : undefined),
        cursor: input.cursor,
        limit: input.limit,
        ...(input.query ? { query: input.query } : undefined),
      });
      return {
        type: "list",
        emptyText: pageEmptyText({ archived, query: input.query }),
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
            ...archiveFacts(memory),
          ],
        })),
      };
    },
  };
}
