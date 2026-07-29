/**
 * Authenticated REST resources for personal memories.
 *
 * HTTP identity is one verified viewer. Linked platform actors are resolved
 * behind the route boundary and used only to authorize personal scopes.
 */
import { z } from "zod";
import {
  pluginApiRouteRequestContextSchema,
  type PluginApiRouteRequestContext,
  type PluginRouteApp,
  type PluginUserPageActor,
} from "@sentry/junior-plugin-api";
import type { MemoryDb, MemoryRecord } from "./store";
import {
  createViewerMemories,
  InvalidMemoryCursorError,
  PersonalMemoryNotFoundError,
} from "./personal";

export const memoryApiSchema = z
  .object({
    content: z.string().min(1),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
    id: z.string().min(1),
    kind: z.enum(["preference", "procedure", "knowledge"]),
    observedAt: z.iso.datetime(),
  })
  .strict();

export const memoryListResponseSchema = z
  .object({
    memories: z.array(memoryApiSchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

export type MemoryApi = z.output<typeof memoryApiSchema>;
export type MemoryListResponse = z.output<typeof memoryListResponseSchema>;

const memoryListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1_000).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
    q: z.string().trim().max(200).optional(),
  })
  .strict();

interface MemoryApiOptions {
  actors(email: string): Promise<PluginUserPageActor[]>;
  db: MemoryDb;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });
}

function apiMemory(memory: MemoryRecord): z.output<typeof memoryApiSchema> {
  return {
    content: memory.content,
    createdAt: new Date(memory.createdAtMs).toISOString(),
    ...(memory.expiresAtMs !== undefined
      ? { expiresAt: new Date(memory.expiresAtMs).toISOString() }
      : {}),
    id: memory.id,
    kind: memory.kind,
    observedAt: new Date(memory.observedAtMs).toISOString(),
  };
}

function viewerEmail(
  context: PluginApiRouteRequestContext | undefined,
): string | undefined {
  const parsed = pluginApiRouteRequestContextSchema.safeParse(context);
  if (!parsed.success || parsed.data.auth.user.emailVerified !== true) {
    return undefined;
  }
  return parsed.data.auth.user.email?.trim().toLowerCase() || undefined;
}

/** Create the authenticated personal-memory REST app. */
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
      if (!isCollection && !memoryPath) {
        return json({ error: "Not found." }, 404);
      }

      const actors = await options.actors(email);
      const memories = createViewerMemories(options.db, actors);
      try {
        if (
          isCollection &&
          (request.method === "GET" || request.method === "HEAD")
        ) {
          const query = memoryListQuerySchema.parse({
            cursor: url.searchParams.get("cursor") ?? undefined,
            limit: url.searchParams.get("limit") ?? undefined,
            q: url.searchParams.get("q") ?? undefined,
          });
          const page = await memories.list({
            cursor: query.cursor,
            limit: query.limit,
            ...(query.q ? { query: query.q } : {}),
          });
          const body = memoryListResponseSchema.parse({
            memories: page.memories.map(apiMemory),
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          });
          return request.method === "HEAD"
            ? new Response(null, {
                headers: { "cache-control": "no-store" },
                status: 200,
              })
            : json(body);
        }

        if (
          memoryPath &&
          (request.method === "GET" || request.method === "HEAD")
        ) {
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
        if (error instanceof PersonalMemoryNotFoundError) {
          return json({ error: error.message }, 404);
        }
        throw error;
      }

      return json({ error: "Method not allowed." }, 405);
    },
  };
}
