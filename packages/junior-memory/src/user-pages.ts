/** Project actor-owned memories into Junior's core-rendered user page. */
import type {
  PluginUserPageActor,
  PluginUserPageDefinition,
} from "@sentry/junior-plugin-api";
import { createMemoryStore, type MemoryDb, type MemoryRecord } from "./store";
import type { MemoryRuntimeContext } from "./types";

const MEMORY_PAGE_LIMIT = 100;

function runtimeContext(
  actor: PluginUserPageActor,
): MemoryRuntimeContext | undefined {
  if (actor.platform === "slack") {
    return {
      actor,
      source: {
        platform: "slack",
        type: "priv",
        teamId: actor.teamId,
        channelId: "DDASHBOARD",
      },
    };
  }
  return {
    actor,
    source: {
      platform: "local",
      type: "priv",
      conversationId: "local:dashboard:memories",
    },
  };
}

function memoryKindLabel(kind: MemoryRecord["kind"]): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function rememberedDate(createdAtMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(createdAtMs));
}

async function readPersonalMemories(
  db: MemoryDb,
  actors: PluginUserPageActor[],
): Promise<MemoryRecord[]> {
  const memories = await Promise.all(
    actors.flatMap((actor) => {
      const context = runtimeContext(actor);
      return context
        ? [
            createMemoryStore(db, context).listPersonalMemories({
              limit: MEMORY_PAGE_LIMIT,
            }),
          ]
        : [];
    }),
  );
  return [
    ...new Map(memories.flat().map((memory) => [memory.id, memory])).values(),
  ]
    .sort((left, right) => right.createdAtMs - left.createdAtMs)
    .slice(0, MEMORY_PAGE_LIMIT);
}

/** Create the read-only personal Memories dashboard page. */
export function createMemoryUserPage(): PluginUserPageDefinition {
  return {
    id: "memories",
    label: "Memories",
    description: "Personal facts and preferences Junior remembers about you.",
    async read(ctx) {
      const memories = await readPersonalMemories(
        ctx.db as MemoryDb,
        ctx.viewer.actors,
      );
      return {
        type: "list",
        emptyText: "No personal memories yet.",
        records: memories.map((memory) => ({
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
