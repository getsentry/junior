/**
 * Authenticated REST access to memory.
 *
 * The signed-in User can read and forget public memory.
 */
import * as z from "zod";
import {
  pluginApiRouteRequestContextSchema,
  type PluginConversationEventReader,
  type PluginConversationEventStats,
  type PluginRouteApp,
  type User,
} from "@sentry/junior-plugin-api";
import type { MemoryDb } from "./store";
import {
  archiveMemory,
  getMemories,
  getMemory,
  getMemoryStats,
  getMemoryTimeline,
  getMemoryTimelineHours,
  InvalidMemoryCursorError,
  listMemories,
  MemoryNotFoundError,
  type MemoryView,
} from "./viewer";
import { parseCapturedMemories, parseRecalledMemoryIds } from "./events";
import {
  extractionCostFlow,
  memoryCostsByDay,
  memoryCostsByHour,
  recallCostFlow,
} from "./model-cost";
import { MEMORY_SOURCE_PLATFORMS } from "./types";

export const memoryApiSchema = z
  .object({
    content: z.string().min(1),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
    id: z.string().min(1),
    kind: z.enum(["preference", "procedure", "knowledge"]),
    observedAt: z.iso.datetime(),
    origin: z.enum(["automatic", "explicit", "other"]),
    sourcePlatform: z.enum(MEMORY_SOURCE_PLATFORMS),
  })
  .strict();

export const memoryListResponseSchema = z
  .object({
    memories: z.array(memoryApiSchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

export const conversationMemorySchema = z
  .object({
    content: z.string().min(1),
    id: z.string().min(1),
    visibility: z.enum(["private", "public"]),
  })
  .strict();

/** One recall or capture in a Conversation, and the memories it touched. */
const conversationMemoryEventSchema = z
  .object({
    memoryIds: z.array(z.string().min(1)).min(1),
    source: z.enum(["captured", "recalled"]),
    turnId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Memories that a Conversation recalled or captured. `events` are in
 * Conversation order, and each id in them is a key of `memories`.
 */
export const conversationMemoryListResponseSchema = z
  .object({
    events: z.array(conversationMemoryEventSchema),
    memories: z.array(conversationMemorySchema),
  })
  .strict();

const memoryBucketSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2})?$/);

const memoryDashboardDaySchema = z
  .object({
    count: z.number().int().min(0),
    date: memoryBucketSchema,
  })
  .strict();

const memoryCostDaySchema = z
  .object({
    costUsd: z.number().finite().nonnegative(),
    date: memoryBucketSchema,
    events: z.number().int().min(0),
  })
  .strict();

export const memoryDashboardResponseSchema = z
  .object({
    days: z.array(memoryDashboardDaySchema).length(90),
    extractionDays: z.array(memoryCostDaySchema).length(90),
    extractionHours: z.array(memoryCostDaySchema).min(24).optional(),
    generatedAt: z.iso.datetime(),
    hours: z.array(memoryDashboardDaySchema).min(24).optional(),
    recallDays: z.array(memoryCostDaySchema).length(90),
    recallHours: z.array(memoryCostDaySchema).min(24).optional(),
    stats: z
      .object({
        active: z.number().int().min(0),
        automatic: z.number().int().min(0),
        createdThirtyDays: z.number().int().min(0),
        embedded: z.number().int().min(0),
        explicit: z.number().int().min(0),
        knowledge: z.number().int().min(0),
        preference: z.number().int().min(0),
        procedure: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

export type MemoryApi = z.output<typeof memoryApiSchema>;
export type MemoryDashboardResponse = z.output<
  typeof memoryDashboardResponseSchema
>;
export type MemoryListResponse = z.output<typeof memoryListResponseSchema>;

const memoryListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1_000).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
    q: z.string().trim().max(200).optional(),
  })
  .strict();

interface MemoryApiOptions {
  conversationEvents: PluginConversationEventReader;
  db: MemoryDb;
  eventStats: PluginConversationEventStats;
  users: {
    resolve(email: string): Promise<User | undefined>;
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });
}

function apiMemory(memory: MemoryView): z.output<typeof memoryApiSchema> {
  return {
    content: memory.content,
    createdAt: new Date(memory.createdAtMs).toISOString(),
    ...(memory.expiresAtMs !== undefined
      ? { expiresAt: new Date(memory.expiresAtMs).toISOString() }
      : undefined),
    id: memory.id,
    kind: memory.kind,
    observedAt: new Date(memory.observedAtMs).toISOString(),
    origin: memory.origin,
    sourcePlatform: memory.sourcePlatform,
  };
}

function currentMemoryVisibility(
  scope: "personal" | "conversation" | "private" | "public",
): "private" | "public" {
  return scope === "personal" || scope === "private" ? "private" : "public";
}

function viewerEmail(context: unknown): string | undefined {
  const parsed = pluginApiRouteRequestContextSchema.safeParse(context);
  if (!parsed.success || parsed.data.auth.user.emailVerified !== true) {
    return undefined;
  }
  return parsed.data.auth.user.email?.trim().toLowerCase() || undefined;
}

/**
 * List what one Conversation recalled and captured, in Conversation order.
 *
 * Captured memories come from the event snapshot. Recall events store only
 * ids, so recalled memories are read from the store, and the viewer sees only
 * the active memories they can access.
 */
async function conversationMemories(args: {
  conversationEvents: PluginConversationEventReader;
  conversationId: string;
  db: MemoryDb;
  viewer: User;
}): Promise<z.output<typeof conversationMemoryListResponseSchema> | undefined> {
  const [captured, recalled] = await Promise.all(
    (["memories_captured", "memories_recalled"] as const).map((eventName) =>
      args.conversationEvents.list({
        conversationId: args.conversationId,
        eventName,
        viewer: args.viewer,
      }),
    ),
  );
  if (!captured || !recalled) return undefined;

  const memories = new Map<string, z.output<typeof conversationMemorySchema>>();
  const capturedEvents = captured.map((event) => {
    const eventMemories = parseCapturedMemories(event.version, event.content);
    for (const memory of eventMemories) {
      memories.set(memory.id, {
        content: memory.content,
        id: memory.id,
        visibility: currentMemoryVisibility(memory.scope),
      });
    }
    return {
      createdAt: event.createdAt,
      memoryIds: eventMemories.map((memory) => memory.id),
      source: "captured" as const,
      turnId: event.turnId,
    };
  });
  const recalledEvents = recalled.map((event) => ({
    createdAt: event.createdAt,
    memoryIds: parseRecalledMemoryIds(event.version, event.content),
    source: "recalled" as const,
    turnId: event.turnId,
  }));
  const capturedIds = new Set(memories.keys());
  // A recall shows only memories the viewer can read in the store now, even
  // when the same memory is in a capture snapshot.
  const recalledIds = new Set<string>();
  for (const memory of await getMemories(args.db, [
    ...new Set(recalledEvents.flatMap((event) => event.memoryIds)),
  ])) {
    recalledIds.add(memory.id);
    if (memories.has(memory.id)) continue;
    memories.set(memory.id, {
      content: memory.content,
      id: memory.id,
      visibility: "public",
    });
  }

  // ISO timestamps sort as text. Recall runs before its Turn replies and
  // capture runs after, so a stable sort keeps one Turn in that order.
  const events = [...recalledEvents, ...capturedEvents]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .flatMap(({ memoryIds, source, turnId }) => {
      const shown = source === "captured" ? capturedIds : recalledIds;
      const visibleIds = memoryIds.filter((id) => shown.has(id));
      if (visibleIds.length === 0) return [];
      return [
        {
          memoryIds: visibleIds,
          source,
          ...(turnId ? { turnId } : undefined),
        },
      ];
    });
  return conversationMemoryListResponseSchema.parse({
    events,
    memories: [...memories.values()],
  });
}

/** Create the authenticated memory REST app. */
export function createMemoryApi(options: MemoryApiOptions): PluginRouteApp {
  return {
    async fetch(request, context) {
      const email = viewerEmail(context);
      if (!email) {
        return json({ error: "Authentication required." }, 401);
      }

      const url = new URL(request.url);
      const memoryPath = /^\/memories\/([^/]+)$/.exec(url.pathname);
      const conversationPath = /^\/conversations\/([^/]+)\/memories$/.exec(
        url.pathname,
      );
      const isCollection = url.pathname === "/memories";
      const isDashboard = url.pathname === "/dashboard";
      if (!isCollection && !isDashboard && !memoryPath && !conversationPath) {
        return json({ error: "Not found." }, 404);
      }
      const isRead = request.method === "GET" || request.method === "HEAD";
      if (!isRead && !(memoryPath && request.method === "DELETE")) {
        return json({ error: "Method not allowed." }, 405);
      }

      const viewer = await options.users.resolve(email);
      if (!viewer) return json({ error: "Authentication required." }, 401);

      try {
        if (isDashboard && isRead) {
          const [
            stats,
            days,
            hours,
            extractionDays,
            extractionHours,
            recallDays,
            recallHours,
          ] = await Promise.all([
            getMemoryStats(options.db),
            getMemoryTimeline(options.db, 90),
            getMemoryTimelineHours(options.db, 7 * 24),
            memoryCostsByDay(options.eventStats, extractionCostFlow, 90),
            memoryCostsByHour(options.eventStats, extractionCostFlow, 7 * 24),
            memoryCostsByDay(options.eventStats, recallCostFlow, 90),
            memoryCostsByHour(options.eventStats, recallCostFlow, 7 * 24),
          ]);
          const body = memoryDashboardResponseSchema.parse({
            days,
            extractionDays,
            extractionHours,
            generatedAt: new Date().toISOString(),
            hours,
            recallDays,
            recallHours,
            stats,
          });
          return request.method === "HEAD"
            ? new Response(null, {
                headers: { "cache-control": "no-store" },
                status: 200,
              })
            : json(body);
        }

        if (conversationPath && isRead) {
          const body = await conversationMemories({
            conversationEvents: options.conversationEvents,
            conversationId: decodeURIComponent(conversationPath[1]!),
            db: options.db,
            viewer,
          });
          if (!body) return json({ error: "Conversation not found." }, 404);
          return request.method === "HEAD"
            ? new Response(null, {
                headers: { "cache-control": "no-store" },
                status: 200,
              })
            : json(body);
        }

        if (isCollection && isRead) {
          const query = memoryListQuerySchema.parse({
            cursor: url.searchParams.get("cursor") ?? undefined,
            limit: url.searchParams.get("limit") ?? undefined,
            q: url.searchParams.get("q") ?? undefined,
          });
          const page = await listMemories(options.db, {
            cursor: query.cursor,
            limit: query.limit,
            ...(query.q ? { query: query.q } : undefined),
          });
          const body = memoryListResponseSchema.parse({
            memories: page.memories.map(apiMemory),
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : undefined),
          });
          return request.method === "HEAD"
            ? new Response(null, {
                headers: { "cache-control": "no-store" },
                status: 200,
              })
            : json(body);
        }

        if (memoryPath && isRead) {
          const memory = await getMemory(
            options.db,
            decodeURIComponent(memoryPath[1]!),
          );
          const body = memoryApiSchema.parse(apiMemory(memory));
          return request.method === "HEAD"
            ? new Response(null, {
                headers: { "cache-control": "no-store" },
                status: 200,
              })
            : json(body);
        }

        if (memoryPath && request.method === "DELETE") {
          const id = decodeURIComponent(memoryPath[1]!);
          await archiveMemory(options.db, id);
          return new Response(null, {
            headers: { "cache-control": "no-store" },
            status: 204,
          });
        }
      } catch (error) {
        if (
          error instanceof z.ZodError ||
          error instanceof InvalidMemoryCursorError
        ) {
          return json({ error: "Invalid memory request." }, 400);
        }
        if (error instanceof MemoryNotFoundError) {
          return json({ error: error.message }, 404);
        }
        throw error;
      }

      return json({ error: "Method not allowed." }, 405);
    },
  };
}
