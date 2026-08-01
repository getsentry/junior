/**
 * Authenticated-viewer memory access shared by REST and dashboard projections.
 *
 * Viewer identity may resolve to multiple platform actors. This module keeps
 * that federation behind one viewer-memory collection spanning personal and
 * authorized public workspace scopes.
 */
import { z } from "zod";
import type { PluginUserPageActor } from "@sentry/junior-plugin-api";
import {
  createPersonalMemoryCollection,
  type MemoryVisibility,
  type PersonalMemoryRecord,
} from "./personal-store";
import type { MemoryDb, MemoryRecord } from "./store";
import type { MemoryKind, MemoryRuntimeContext } from "./types";

const cursorSchema = z
  .object({
    createdAtMs: z.number().finite(),
    id: z.string().min(1),
    kind: z.enum(["preference", "procedure", "knowledge"]).optional(),
    origin: z.enum(["automatic", "explicit"]).optional(),
    query: z.string().max(200).optional(),
    version: z.literal(1),
    visibility: z.enum(["private", "public"]).optional(),
  })
  .strict();

export interface ViewerMemoryPage {
  memories: PersonalMemoryRecord[];
  nextCursor?: string;
}

export interface ViewerMemoryPageInput {
  cursor?: string;
  kind?: MemoryKind;
  limit: number;
  origin?: "automatic" | "explicit";
  query?: string;
  visibility?: MemoryVisibility;
}

export class InvalidMemoryCursorError extends Error {
  constructor() {
    super("Memory cursor is invalid.");
    this.name = "InvalidMemoryCursorError";
  }
}

export { PersonalMemoryNotFoundError } from "./personal-store";
export type { MemoryVisibility, PersonalMemoryRecord } from "./personal-store";

function runtimeContext(actor: PluginUserPageActor): MemoryRuntimeContext {
  if (actor.platform === "slack") {
    return {
      actor,
      source: {
        platform: "slack",
        visibility: "private",
        teamId: actor.teamId,
        channelId: "DDASHBOARD",
      },
    };
  }
  return {
    actor,
    source: {
      platform: "local",
      visibility: "private",
      conversationId: "local:dashboard:memories",
    },
  };
}

function decodeCursor(
  value: string | undefined,
  input: Pick<
    ViewerMemoryPageInput,
    "kind" | "origin" | "query" | "visibility"
  >,
) {
  if (!value) return undefined;
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (
      parsed.query !== input.query ||
      parsed.kind !== input.kind ||
      parsed.origin !== input.origin ||
      parsed.visibility !== input.visibility
    ) {
      throw new InvalidMemoryCursorError();
    }
    return { createdAtMs: parsed.createdAtMs, id: parsed.id };
  } catch {
    throw new InvalidMemoryCursorError();
  }
}

function encodeCursor(
  cursor: { createdAtMs: number; id: string },
  input: Pick<
    ViewerMemoryPageInput,
    "kind" | "origin" | "query" | "visibility"
  >,
): string {
  return Buffer.from(
    JSON.stringify({
      ...cursor,
      ...(input.query ? { query: input.query } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
      version: 1,
    }),
    "utf8",
  ).toString("base64url");
}

/** Build viewer memory operations authorized by a viewer's linked actors. */
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
    async get(id: string): Promise<PersonalMemoryRecord> {
      return await collection.get(id);
    },
    async list(input: ViewerMemoryPageInput): Promise<ViewerMemoryPage> {
      const query = input.query?.trim() || undefined;
      const filters = {
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
        ...(query ? { query } : {}),
        ...(input.visibility ? { visibility: input.visibility } : {}),
      };
      const page = await collection.list({
        cursor: decodeCursor(input.cursor, filters),
        ...filters,
        limit: input.limit,
      });
      return {
        memories: page.memories,
        ...(page.nextCursor
          ? { nextCursor: encodeCursor(page.nextCursor, filters) }
          : {}),
      };
    },
    async stats() {
      return await collection.stats();
    },
    async timeline(input: { days: number }) {
      return await collection.timeline(input);
    },
  };
}
