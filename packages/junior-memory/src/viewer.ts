/**
 * Authenticated-viewer memory access shared by REST and dashboard projections.
 *
 * Authenticated viewers can inspect public memory plus private memory owned by
 * their linked canonical user.
 */
import { z } from "zod";
import {
  createViewerMemoryCollection,
  type MemoryVisibility,
  type ViewerMemory,
} from "./viewer-store";
import type { MemoryDb } from "./store";
import type { MemoryKind } from "./types";

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
  memories: ViewerMemory[];
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

export { ViewerMemoryNotFoundError } from "./viewer-store";
export type { MemoryVisibility, ViewerMemory } from "./viewer-store";

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
      ...(input.query ? { query: input.query } : undefined),
      ...(input.kind ? { kind: input.kind } : undefined),
      ...(input.origin ? { origin: input.origin } : undefined),
      ...(input.visibility ? { visibility: input.visibility } : undefined),
      version: 1,
    }),
    "utf8",
  ).toString("base64url");
}

/** Build memory operations authorized for one linked viewer. */
export function createViewerMemories(db: MemoryDb, viewer: { id: string }) {
  const collection = createViewerMemoryCollection(db, viewer);
  return {
    archive: collection.archive,
    get: collection.get,
    async list(input: ViewerMemoryPageInput): Promise<ViewerMemoryPage> {
      const query = input.query?.trim() || undefined;
      const filters = {
        ...(input.kind ? { kind: input.kind } : undefined),
        ...(input.origin ? { origin: input.origin } : undefined),
        ...(query ? { query } : undefined),
        ...(input.visibility ? { visibility: input.visibility } : undefined),
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
          : undefined),
      };
    },
    stats: collection.stats,
    timeline: collection.timeline,
  };
}
