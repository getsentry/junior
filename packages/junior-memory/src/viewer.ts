/**
 * Authenticated-viewer memory access shared by REST and dashboard projections.
 *
 * Authenticated viewers can inspect globally public memory. Private memory
 * stays inside the source domain that learned it.
 */
import { z } from "zod";
import {
  createViewerMemoryCollection,
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
}

export class InvalidMemoryCursorError extends Error {
  constructor() {
    super("Memory cursor is invalid.");
    this.name = "InvalidMemoryCursorError";
  }
}

export { ViewerMemoryNotFoundError } from "./viewer-store";
export type { ViewerMemory } from "./viewer-store";

function decodeCursor(
  value: string | undefined,
  input: Pick<ViewerMemoryPageInput, "kind" | "origin" | "query">,
) {
  if (!value) return undefined;
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (
      parsed.query !== input.query ||
      parsed.kind !== input.kind ||
      parsed.origin !== input.origin
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
  input: Pick<ViewerMemoryPageInput, "kind" | "origin" | "query">,
): string {
  return Buffer.from(
    JSON.stringify({
      ...cursor,
      ...(input.query ? { query: input.query } : undefined),
      ...(input.kind ? { kind: input.kind } : undefined),
      ...(input.origin ? { origin: input.origin } : undefined),
      version: 1,
    }),
    "utf8",
  ).toString("base64url");
}

/** Build viewer memory operations for globally public memory. */
export function createViewerMemories(db: MemoryDb) {
  const collection = createViewerMemoryCollection(db);
  return {
    async get(id: string): Promise<ViewerMemory> {
      return await collection.get(id);
    },
    async list(input: ViewerMemoryPageInput): Promise<ViewerMemoryPage> {
      const query = input.query?.trim() || undefined;
      const filters = {
      ...(input.kind ? { kind: input.kind } : undefined),
      ...(input.origin ? { origin: input.origin } : undefined),
      ...(query ? { query } : undefined),
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
    async stats() {
      return await collection.stats();
    },
    async timeline(input: { days: number }) {
      return await collection.timeline(input);
    },
  };
}
