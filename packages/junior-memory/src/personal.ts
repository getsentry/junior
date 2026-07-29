/**
 * Authenticated-viewer memory access shared by REST and dashboard projections.
 *
 * Viewer identity may resolve to multiple platform actors. This module keeps
 * that federation behind one personal-memory collection.
 */
import { z } from "zod";
import type { PluginUserPageActor } from "@sentry/junior-plugin-api";
import { createPersonalMemoryCollection } from "./personal-store";
import type { MemoryDb, MemoryRecord } from "./store";
import type { MemoryRuntimeContext } from "./types";

const cursorSchema = z
  .object({
    createdAtMs: z.number().finite(),
    id: z.string().min(1),
    query: z.string().max(200).optional(),
    version: z.literal(1),
  })
  .strict();

export interface ViewerMemoryPage {
  memories: MemoryRecord[];
  nextCursor?: string;
}

export interface ViewerMemoryPageInput {
  cursor?: string;
  limit: number;
  query?: string;
}

export class InvalidMemoryCursorError extends Error {
  constructor() {
    super("Memory cursor is invalid.");
    this.name = "InvalidMemoryCursorError";
  }
}

export { PersonalMemoryNotFoundError } from "./personal-store";

function runtimeContext(actor: PluginUserPageActor): MemoryRuntimeContext {
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

function decodeCursor(value: string | undefined, query: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (parsed.query !== query) {
      throw new InvalidMemoryCursorError();
    }
    return { createdAtMs: parsed.createdAtMs, id: parsed.id };
  } catch {
    throw new InvalidMemoryCursorError();
  }
}

function encodeCursor(
  cursor: { createdAtMs: number; id: string },
  query: string | undefined,
): string {
  return Buffer.from(
    JSON.stringify({ ...cursor, ...(query ? { query } : {}), version: 1 }),
    "utf8",
  ).toString("base64url");
}

/** Build personal-memory operations authorized by a viewer's linked actors. */
export function createViewerMemories(
  db: MemoryDb,
  actors: PluginUserPageActor[],
) {
  const collection = createPersonalMemoryCollection(
    db,
    actors.map(runtimeContext),
  );
  return {
    async archive(id: string): Promise<MemoryRecord> {
      return await collection.archive(id);
    },
    async get(id: string): Promise<MemoryRecord> {
      return await collection.get(id);
    },
    async list(input: ViewerMemoryPageInput): Promise<ViewerMemoryPage> {
      const query = input.query?.trim() || undefined;
      const page = await collection.list({
        cursor: decodeCursor(input.cursor, query),
        limit: input.limit,
        ...(query ? { query } : {}),
      });
      return {
        memories: page.memories,
        ...(page.nextCursor
          ? { nextCursor: encodeCursor(page.nextCursor, query) }
          : {}),
      };
    },
  };
}
