/**
 * Authenticated REST resources for viewer-visible memories.
 *
 * HTTP identity authenticates the request and resolves the linked user used
 * for private source-domain access.
 */
import { z } from "zod";
import {
  pluginApiRouteRequestContextSchema,
  type PluginConversationEventStats,
  type PluginRouteApp,
  type User,
} from "@sentry/junior-plugin-api";
import type { MemoryDb } from "./store";
import {
  createViewerMemories,
  InvalidMemoryCursorError,
  ViewerMemoryNotFoundError,
  type ViewerMemory,
} from "./viewer";
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
    visibility: z.enum(["private", "public"]),
  })
  .strict();

export const memoryListResponseSchema = z
  .object({
    memories: z.array(memoryApiSchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

const memoryDashboardDaySchema = z
  .object({
    date: z.iso.date(),
    private: z.number().int().min(0),
    public: z.number().int().min(0),
  })
  .strict();

const memoryCostDaySchema = z
  .object({
    costUsd: z.number().finite().nonnegative(),
    date: z.iso.date(),
    events: z.number().int().min(0),
  })
  .strict();

export const memoryDashboardResponseSchema = z
  .object({
    days: z.array(memoryDashboardDaySchema).length(90),
    extractionDays: z.array(memoryCostDaySchema).length(90),
    generatedAt: z.iso.datetime(),
    recallDays: z.array(memoryCostDaySchema).length(90),
    stats: z
      .object({
        active: z.number().int().min(0),
        automatic: z.number().int().min(0),
        createdThirtyDays: z.number().int().min(0),
        embedded: z.number().int().min(0),
        explicit: z.number().int().min(0),
        knowledge: z.number().int().min(0),
        private: z.number().int().min(0),
        preference: z.number().int().min(0),
        procedure: z.number().int().min(0),
        public: z.number().int().min(0),
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

function apiMemory(memory: ViewerMemory): z.output<typeof memoryApiSchema> {
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
    visibility: memory.visibility,
  };
}

function viewerEmail(context: unknown): string | undefined {
  const parsed = pluginApiRouteRequestContextSchema.safeParse(context);
  if (!parsed.success || parsed.data.auth.user.emailVerified !== true) {
    return undefined;
  }
  return parsed.data.auth.user.email?.trim().toLowerCase() || undefined;
}

/** Create the authenticated viewer-memory REST app. */
export function createMemoryApi(options: MemoryApiOptions): PluginRouteApp {
  return {
    async fetch(request, context) {
      const email = viewerEmail(context);
      if (!email) {
        return json({ error: "Authentication required." }, 401);
      }

      const url = new URL(request.url);
      const memoryPath = /^\/memories\/([^/]+)$/.exec(url.pathname);
      const isCollection = url.pathname === "/memories";
      const isDashboard = url.pathname === "/dashboard";
      if (!isCollection && !isDashboard && !memoryPath) {
        return json({ error: "Not found." }, 404);
      }
      const isRead = request.method === "GET" || request.method === "HEAD";
      if (!isRead && !(memoryPath && request.method === "DELETE")) {
        return json({ error: "Method not allowed." }, 405);
      }

      const viewer = await options.users.resolve(email);
      if (!viewer) return json({ error: "Authentication required." }, 401);

      const memories = createViewerMemories(options.db, viewer);
      try {
        if (isDashboard && isRead) {
          const [stats, days, extractionDays, recallDays] = await Promise.all([
            memories.stats(),
            memories.timeline({ days: 90 }),
            options.eventStats.costsByDay({
              days: 90,
              eventName: "memories_captured",
            }),
            options.eventStats.costsByDay({
              days: 90,
              eventName: "memories_recalled",
            }),
          ]);
          const body = memoryDashboardResponseSchema.parse({
            days,
            extractionDays,
            generatedAt: new Date().toISOString(),
            recallDays,
            stats,
          });
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
          const page = await memories.list({
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
          const memory = memoryApiSchema.parse(
            apiMemory(await memories.get(decodeURIComponent(memoryPath[1]!))),
          );
          return request.method === "HEAD"
            ? new Response(null, {
                headers: { "cache-control": "no-store" },
                status: 200,
              })
            : json(memory);
        }

        if (memoryPath && request.method === "DELETE") {
          await memories.archive(decodeURIComponent(memoryPath[1]!));
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
        if (error instanceof ViewerMemoryNotFoundError) {
          return json({ error: error.message }, 404);
        }
        throw error;
      }

      return json({ error: "Method not allowed." }, 405);
    },
  };
}
